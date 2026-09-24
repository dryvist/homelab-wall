import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1920, height: 1080 },
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory site',
    url: 'http://127.0.0.1:4173/mc1/',
    reuseExistingServer: true,
  },
});
