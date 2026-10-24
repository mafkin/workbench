import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:7431',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'npx vite build --logLevel warn && node e2e/serve.ts',
      url: 'http://127.0.0.1:7431/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The same service without a Workbench folder, for the setup screen.
      command: 'node e2e/serve.ts',
      url: 'http://127.0.0.1:7432/api/health',
      env: { E2E_SETUP: '1' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
