import { defineConfig } from '@playwright/test';

// WALL_URL points the suite at a live site instead of the local fixture server.
// WALL_PROXY (e.g. socks5://127.0.0.1:1088) routes the browser through it.
// WALL_STATE is an optional storageState file for an already-authenticated session.
const wallUrl = process.env.WALL_URL;

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  use: {
    baseURL: wallUrl || 'http://127.0.0.1:4173',
    viewport: { width: 1920, height: 1080 },
    ...(process.env.WALL_PROXY ? { launchOptions: { proxy: { server: process.env.WALL_PROXY } } } : {}),
    ...(process.env.WALL_STATE ? { storageState: process.env.WALL_STATE } : {}),
  },
  webServer: wallUrl ? undefined : {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory site',
    url: 'http://127.0.0.1:4173/mc1/',
    reuseExistingServer: true,
  },
});
