import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * This project does not use the Playwright *test* runner for capture — the
 * capture path is a plain Node orchestrator (src/runner.ts) so that flow
 * ordering, skip logic and cleanup stay under our control.
 *
 * This config exists so that (a) `npx playwright` CLI commands pick up sane
 * defaults, and (b) the same browser/viewport settings are declared in one
 * place and re-read by src/browser.ts.
 */
export default defineConfig({
  testDir: './src/__checks__',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // Chrome-on-Android base: mobile UA, isMobile, hasTouch, chromium engine.
    // The env-driven viewport/deviceScaleFactor below deliberately override the
    // preset's own values so 390x844 @2x stays the single source of truth.
    ...devices['Pixel 7'],
    baseURL: process.env.APP_URL ?? 'https://rosi-fit.vercel.app',
    headless: process.env.HEADLESS !== 'false',
    viewport: {
      width: Number(process.env.VIEWPORT_WIDTH ?? 390),
      height: Number(process.env.VIEWPORT_HEIGHT ?? 844),
    },
    deviceScaleFactor: Number(process.env.DEVICE_SCALE_FACTOR ?? 2),
    colorScheme: process.env.COLOR_SCHEME === 'light' ? 'light' : 'dark',
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: false,
    actionTimeout: Number(process.env.STEP_TIMEOUT_MS ?? 15_000),
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
