import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const releaseBuild = command === "build" && env.DRG_RELEASE_BUILD === "1";
  const configured = command === "build" && Boolean(env.VITE_SENTRY_DSN);
  if (releaseBuild && !configured) throw new Error("Release builds require the dedicated DR.GLITCH Sentry DSN.");
  if (configured) {
    let dsn: URL;
    try { dsn = new URL(env.VITE_SENTRY_DSN!); } catch { throw new Error("Invalid public Sentry DSN."); }
    if (dsn.protocol !== "https:" || !/^o\d+\.ingest(?:\.[a-z]{2})?\.sentry\.io$/.test(dsn.hostname)
      || !/^[a-f0-9]{32}$/.test(dsn.username) || !/^\/\d+$/.test(dsn.pathname)
      || dsn.password || dsn.port || dsn.search || dsn.hash) throw new Error("Invalid public Sentry DSN.");
    if (!env.VITE_SENTRY_RELEASE || !/^[a-f0-9]{40}$/.test(env.VITE_SENTRY_RELEASE)) {
      throw new Error("Sentry release must be the exact 40-character Git commit SHA.");
    }
    if (env.WORKERS_CI_COMMIT_SHA && env.WORKERS_CI_COMMIT_SHA !== env.VITE_SENTRY_RELEASE) {
      throw new Error("Sentry release differs from the Workers Builds commit.");
    }
    if (releaseBuild && !/^[a-f0-9]{40}$/.test(env.WORKERS_CI_COMMIT_SHA ?? "")) {
      throw new Error("Release builds require the exact managed source commit SHA.");
    }
    if (!env.SENTRY_AUTH_TOKEN || !env.SENTRY_ORG || !env.SENTRY_PROJECT) {
      throw new Error("Configured telemetry requires private source-map upload credentials, organization and project.");
    }
    if (!["production", "private-validation"].includes(env.VITE_SENTRY_ENVIRONMENT ?? "")) {
      throw new Error("Set the Sentry environment to production or private-validation.");
    }
    if (env.VITE_SENTRY_ENVIRONMENT === "production" && ["1", "true"].includes(env.VITE_SENTRY_PRIVATE_VALIDATION ?? "")) {
      throw new Error("Production traces must retain the 10% sampling rate.");
    }
  }
  return {
    plugins: [react(), tailwindcss(), cloudflare(), ...(configured ? [sentryVitePlugin({
      authToken: env.SENTRY_AUTH_TOKEN,
      org: env.SENTRY_ORG,
      project: env.SENTRY_PROJECT,
      telemetry: false,
      release: { name: env.VITE_SENTRY_RELEASE, create: true, finalize: true },
      sourcemaps: { assets: ["./dist/**"], filesToDeleteAfterUpload: ["./dist/**/*.map"] },
      // The plugin's default error handling fails the build on upload failure.
    })] : [])],
    build: { outDir: "dist", sourcemap: configured ? "hidden" as const : false },
  };
});
