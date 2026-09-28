import { defineConfig } from "@playwright/test";
import existing from "./playwright.config";
const builtClient = process.env.DRG_E2E_BUILT_CLIENT === "1";
export default defineConfig({
  ...existing,
  testIgnore: [],
  testMatch: "**/browser-workflow.spec.ts",
  webServer: {
    ...existing.webServer,
    command: builtClient
      ? "python3 -m http.server 4343 --bind 127.0.0.1 --directory dist/client"
      : "VITE_DRG_WORKSTATION_REVIEW=0 npm run dev -- --host 127.0.0.1 --port 4343 --strictPort",
    url: "http://127.0.0.1:4343",
    reuseExistingServer: false,
  },
  use: { ...existing.use, baseURL: "http://127.0.0.1:4343", actionTimeout: 10_000 },
});
