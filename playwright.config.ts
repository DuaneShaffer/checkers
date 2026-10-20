import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

function isUbuntu2004(): boolean {
  try {
    return /VERSION_ID="20\.04"/.test(readFileSync('/etc/os-release', 'utf8'));
  } catch {
    return false;
  }
}
if (isUbuntu2004()) process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE ??= 'ubuntu22.04-x64';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const chromiumArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=WebRtcHideLocalIpsWithMdns'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/checkers/`,
    trace: 'retain-on-failure',
    launchOptions: { args: chromiumArgs },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/checkers/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
