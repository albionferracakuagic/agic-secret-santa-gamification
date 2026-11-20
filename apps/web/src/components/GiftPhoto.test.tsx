import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiftPhoto, GiftPhotoPreview, safePhotoUrl } from './GiftPhoto';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockImageRasterizer() {
  const bitmap = { width: 2, height: 3, close: vi.fn() } as unknown as ImageBitmap;
  const createImageBitmap = vi.fn(async () => bitmap);
  const drawImage = vi.fn();
  const rasterizedBlob = new Blob(['rasterized pixels'], { type: 'image/png' });
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(rasterizedBlob);
  });
  return { bitmap, createImageBitmap, drawImage, rasterizedBlob };
}

describe('gift photo URLs', () => {
  it('normalizes relative media URLs and keeps signed HTTPS URLs', () => {
    expect(safePhotoUrl('/media/gifts/e1/a.jpg?exp=10&sig=test')).toBe(
      new URL('/media/gifts/e1/a.jpg?exp=10&sig=test', window.location.origin).href,
    );
    expect(
      safePhotoUrl(
        'https://account.blob.core.windows.net/gifts/e1/a.jpg?sv=1&se=2026-12-20&sig=signed',
      ),
    ).toBe('https://account.blob.core.windows.net/gifts/e1/a.jpg?sv=1&se=2026-12-20&sig=signed');
  });

  it('rejects unsafe and malformed server values', () => {
    expect(safePhotoUrl('javascript:alert(1)')).toBeUndefined();
    expect(safePhotoUrl('http://remote.example/photo.jpg')).toBeUndefined();
    expect(safePhotoUrl('http://[')).toBeUndefined();
  });

  it('shows a fallback when an image cannot load', () => {
    render(
      <GiftPhoto
        src="/media/gifts/e1/missing.jpg?exp=10&sig=test"
        alt="Gift"
        className="photo"
        testId="photo"
        fallback={<span data-testid="fallback">🎁</span>}
      />,
    );
    const photo = screen.getByTestId('photo');
    fireEvent.error(photo);
    expect(screen.queryByTestId('photo')).toBeNull();
    expect(screen.getByTestId('fallback')).toBeTruthy();
  });

  it('renders blob previews and revokes them on unmount', async () => {
    const { bitmap, createImageBitmap, drawImage, rasterizedBlob } = mockImageRasterizer();
    const createObjectURL = vi.fn(() => 'blob:gift-preview');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0x00])],
      'gift.jpg',
      { type: 'image/jpeg' },
    );

    const view = render(
      <GiftPhotoPreview file={file} alt="Preview" className="preview" />,
    );
    expect((await screen.findByTestId('gift-photo-preview')).getAttribute('src')).toBe(
      'blob:gift-preview',
    );
    expect(createImageBitmap).toHaveBeenCalledWith(file);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(createObjectURL).toHaveBeenCalledWith(rasterizedBlob);
    expect(createObjectURL).not.toHaveBeenCalledWith(file);
    expect(bitmap.close).toHaveBeenCalledOnce();

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gift-preview');
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('rejects HTML and SVG, including raster-MIME files with non-raster contents', async () => {
    const { createImageBitmap } = mockImageRasterizer();
    const createObjectURL = vi.fn(() => 'blob:unsafe-preview');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });

    const cases: [string, string, string][] = [
      ['gift.html', 'text/html', '<html>unsafe</html>'],
      ['gift.svg', 'image/svg+xml', '<svg>unsafe</svg>'],
      ['gift.svg', 'image/svg+xml;charset=utf-8', '<svg>unsafe</svg>'],
      ['spoofed.png', 'image/png', '<svg><script>alert(1)</script></svg>'],
      ['spoofed.jpg', 'image/jpeg', '<html>unsafe</html>'],
    ];
    for (const [name, type, contents] of cases) {
      const view = render(
        <GiftPhotoPreview
          file={new File([contents], name, { type })}
          alt="Preview"
          className="preview"
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByTestId('gift-photo-preview')).toBeNull();
      view.unmount();
    }

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
    Reflect.deleteProperty(URL, 'createObjectURL');
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'creates previews for the supported %s format',
    async (type) => {
      const { createImageBitmap, rasterizedBlob } = mockImageRasterizer();
      const createObjectURL = vi.fn(() => 'blob:supported-preview');
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
      const signatures: Record<string, number[]> = {
        'image/jpeg': [0xff, 0xd8, 0xff, 0x00],
        'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        'image/webp': [
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        ],
      };
      const file = new File(
        [new Uint8Array(signatures[type] ?? [])],
        `gift.${type.slice('image/'.length)}`,
        { type },
      );

      const view = render(
        <GiftPhotoPreview file={file} alt="Preview" className="preview" />,
      );

      await screen.findByTestId('gift-photo-preview');
      expect(createImageBitmap).toHaveBeenCalledWith(file);
      expect(createObjectURL).toHaveBeenCalledWith(rasterizedBlob);
      expect(createObjectURL).not.toHaveBeenCalledWith(file);
      view.unmount();
      Reflect.deleteProperty(URL, 'createObjectURL');
    },
  );
});
