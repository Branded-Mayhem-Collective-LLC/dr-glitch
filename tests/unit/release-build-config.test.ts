import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("vite", () => ({ defineConfig: (config: unknown) => config, loadEnv: () => ({}) }));
vi.mock("@cloudflare/vite-plugin", () => ({ cloudflare: () => ({ name: "cloudflare" }) }));
vi.mock("@vitejs/plugin-react", () => ({ default: () => ({ name: "react" }) }));
vi.mock("@tailwindcss/vite", () => ({ default: () => ({ name: "tailwind" }) }));
vi.mock("@sentry/vite-plugin", () => ({ sentryVitePlugin: (options: unknown) => ({ name: "sentry", options }) }));
import config from "../../vite.config";

const SHA = "a".repeat(40);
const build = () => {
  if (typeof config !== "function") throw new Error("Expected conditional build configuration.");
  return config({ command: "build", mode: "production" });
};
beforeEach(() => {
  for (const key of ["DRG_RELEASE_BUILD", "VITE_SENTRY_DSN", "VITE_SENTRY_RELEASE", "VITE_SENTRY_ENVIRONMENT", "VITE_SENTRY_PRIVATE_VALIDATION", "WORKERS_CI_COMMIT_SHA", "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

function configured() {
  for (const [key, value] of Object.entries({ DRG_RELEASE_BUILD: "1", VITE_SENTRY_DSN: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@o1.ingest.sentry.io/1", VITE_SENTRY_RELEASE: SHA, WORKERS_CI_COMMIT_SHA: SHA, VITE_SENTRY_ENVIRONMENT: "production", SENTRY_AUTH_TOKEN: "test-only-private-upload-token", SENTRY_ORG: "test-org", SENTRY_PROJECT: "test-project" })) vi.stubEnv(key, value);
}

it("refuses a release without dedicated telemetry", () => {
  vi.stubEnv("DRG_RELEASE_BUILD", "1");
  expect(build).toThrow(/Sentry DSN/);
});
it.each([
  ["VITE_SENTRY_DSN", "invalid", /Invalid public Sentry DSN/],
  ["WORKERS_CI_COMMIT_SHA", "", /managed source commit/],
  ["VITE_SENTRY_RELEASE", "main", /exact 40-character/],
  ["WORKERS_CI_COMMIT_SHA", "b".repeat(40), /differs/],
  ["SENTRY_AUTH_TOKEN", "", /private source-map/],
  ["SENTRY_PROJECT", "", /private source-map/],
  ["VITE_SENTRY_ENVIRONMENT", "unknown", /environment/],
  ["VITE_SENTRY_PRIVATE_VALIDATION", "1", /10%/],
])("refuses an invalid %s release setting", (key, value, error) => {
  configured(); vi.stubEnv(key as string, value as string);
  expect(build).toThrow(error as RegExp);
});
it("uses hidden maps and private upload followed by deletion, with upload failures fatal", async () => {
  configured();
  const result = await build();
  expect(result.build?.sourcemap).toBe("hidden");
  const plugin = result.plugins?.flat().find((entry) => entry && typeof entry === "object" && "name" in entry && entry.name === "sentry") as unknown as { options: Record<string, unknown> };
  expect(plugin.options).toMatchObject({ telemetry: false, release: { name: SHA, create: true, finalize: true }, sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] } });
  expect(plugin.options).not.toHaveProperty("errorHandler");
});
