import { defineConfig, devices } from '@playwright/test';

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
  // The kiosk itself only ever runs in Chromium, but the wall is viewed and debugged in Safari
  // too (WebKit) — its layout engine differs enough (grid track sizing, containment) that a
  // Chromium-only suite has missed real regressions there. Both engines run at the Mac Studio's
  // own size (1920x1080) at DPR 1 and 2 (the WebKit growth bug only showed at DPR 2); the two
  // other sizes each get one project per engine to keep the matrix lean.
  projects: [
    { name: 'chromium-1920x1080@1', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
    { name: 'chromium-1920x1080@2', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 } },
    { name: 'webkit-1920x1080@1', use: { ...devices['Desktop Safari'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
    { name: 'webkit-1920x1080@2', use: { ...devices['Desktop Safari'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 } },
    { name: 'chromium-2560x1440', use: { ...devices['Desktop Chrome'], viewport: { width: 2560, height: 1440 } } },
    { name: 'webkit-2560x1440', use: { ...devices['Desktop Safari'], viewport: { width: 2560, height: 1440 } } },
    { name: 'chromium-1440x900', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit-1440x900', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: wallUrl ? undefined : {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory site',
    url: 'http://127.0.0.1:4173/mc1/',
    reuseExistingServer: true,
  },
});
