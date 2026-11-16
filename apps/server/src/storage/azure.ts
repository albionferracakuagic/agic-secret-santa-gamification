import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  generateBlobSASQueryParameters,
  type UserDelegationKey,
} from '@azure/storage-blob';
import { isValidKey, type StorageAdapter } from './adapter.js';

/** Minimal client surface we use (lets tests inject a fake without network). */
export interface BlobServiceLike {
  getUserDelegationKey(start: Date, expiry: Date): Promise<UserDelegationKey>;
  getContainerClient(name: string): {
    getBlockBlobClient(blob: string): {
      url: string;
      uploadData(
        data: Buffer,
        o: { blobHTTPHeaders: { blobContentType: string } },
      ): Promise<unknown>;
      deleteIfExists(): Promise<unknown>;
    };
  };
}

/**
 * Azure Blob with managed identity (no keys: shared-key access is disabled in infra) and short-lived
 * user-delegation SAS read URLs. The delegation key is cached and refreshed before it expires.
 */
export class AzureBlobStorage implements StorageAdapter {
  private key: { value: UserDelegationKey; expiresAt: number } | undefined;

  constructor(
    private readonly o: {
      accountName: string;
      container: string;
      client?: BlobServiceLike;
      now?: () => number;
    },
  ) {
    this.client =
      o.client ??
      (new BlobServiceClient(
        `https://${o.accountName}.blob.core.windows.net`,
        new DefaultAzureCredential(),
      ) as unknown as BlobServiceLike);
  }

  private readonly client: BlobServiceLike;
  private now = () => (this.o.now ?? Date.now)();

  private blob(key: string) {
    if (!isValidKey(key)) throw new Error('invalid storage key');
    return this.client.getContainerClient(this.o.container).getBlockBlobClient(key);
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.blob(key).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async delete(key: string) {
    await this.blob(key).deleteIfExists();
  }

  private async delegationKey(): Promise<UserDelegationKey> {
    const t = this.now();
    if (this.key && this.key.expiresAt - t > 5 * 60_000) return this.key.value;
    const start = new Date(t - 5 * 60_000); // clock-skew allowance
    const expiry = new Date(t + 60 * 60_000);
    const value = await this.client.getUserDelegationKey(start, expiry);
    this.key = { value, expiresAt: expiry.getTime() };
    return value;
  }

  async readUrl(key: string, ttlSeconds: number): Promise<string> {
    const t = this.now();
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.o.container,
        blobName: key,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(t - 60_000),
        expiresOn: new Date(t + ttlSeconds * 1000),
        protocol: SASProtocol.Https,
      },
      await this.delegationKey(),
      this.o.accountName,
    ).toString();
    return `${this.blob(key).url}?${sas}`;
  }
}
