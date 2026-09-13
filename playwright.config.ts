import { defineConfig } from "@playwright/test";

// Private-preview port. Defaults to the registered 4343; DRG_E2E_PORT lets
// parallel local triage runs use distinct loopback ports without colliding.
const port = Number(process.env.DRG_E2E_PORT ?? 4343);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
