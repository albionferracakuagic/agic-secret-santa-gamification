import { buildApp } from './app.js';

const app = buildApp();
const port = Number(process.env['PORT'] ?? 3000);

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`server listening on :${port}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
