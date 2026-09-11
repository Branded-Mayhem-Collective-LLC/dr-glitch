import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// Keep Vite's production plugin out of Node unit tests. Worker tests use only
// isolated local bindings: never the deployment database or saved credentials.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      {
        plugins: [cloudflareTest(async () => ({
          main: "./worker/index.ts",
          remoteBindings: false,
          miniflare: {
            compatibilityDate: "2026-05-22",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: ["DATABASE"],
            bindings: {
              BETTER_AUTH_URL: "https://studio.example.test",
              BETTER_AUTH_SECRET: "worker-test-only-secret-0123456789abcdef",
              TEST_MIGRATIONS: await readD1Migrations("./drizzle"),
            },
          },
        }))],
        test: {
          name: "worker", include: ["tests/worker/**/*.test.ts"],
          setupFiles: ["./tests/worker/setup.ts"], fileParallelism: false,
          testTimeout: 15000,
        },
      },
    ],
  },
});
