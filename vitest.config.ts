import { defineConfig } from "vitest/config";

// Intentionally empty: shadows vite.config.ts so Vitest does not load the cloudflare() plugin,
// which crashes on node-environment test projects. Do not delete.
export default defineConfig({});
