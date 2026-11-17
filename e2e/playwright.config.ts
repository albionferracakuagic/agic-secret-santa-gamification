import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: '../test-results',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    { name: 'chromium', testDir: './tests', use: { ...devices['Desktop Chrome'] } },
    // Real server (PGlite) serving the built SPA: one full lifecycle (organizer -> guests -> vote -> close).
    {
      name: 'fullstack',
      testDir: './fullstack',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4180' },
    },
  ],
  webServer: [
    {
      command:
        'npm run build -w apps/web && npm run preview -w apps/web -- --port 4173 --strictPort',
      cwd: '..',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run build -w apps/web && npx tsx e2e/fullstack/boot.ts',
      cwd: '..',
      url: 'http://localhost:4180/health',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
