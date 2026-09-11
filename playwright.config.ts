import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4343",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4343 --strictPort",
    url: "http://127.0.0.1:4343",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
