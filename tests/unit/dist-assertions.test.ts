/**
 * Release-integrity assertions over the production build (scripts/
 * verify-dist.mjs run as an executable gate). SKIPPED when dist/ is absent:
 * the unit suite must stay runnable without a prior `npm run build`, and a
 * skip here is honest — the lead's release gate runs `npm run build`
 * followed by this suite (or `node scripts/verify-dist.mjs` directly), at
 * which point the assertions are live.
 *
 * Contract verified (see the script for calibration notes):
 * - no *.map files and no external sourceMappingURL references;
 * - public Sentry DSN/release/debug IDs are allowed, private tokens are not;
 * - no dev-only chunks: component lab (/dev/lab) and the debug seams
 *   (export tile delay, simulated quota) are dead-code-eliminated.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const distDir = join(repoRoot, "dist");
const script = join(repoRoot, "scripts", "verify-dist.mjs");

describe.skipIf(!existsSync(distDir))("production dist assertions", () => {
  it("verify-dist passes: no public maps, private tokens, or dev chunks", () => {
    const output = execFileSync(process.execPath, [script, distDir], {
      encoding: "utf8",
    });
    expect(output).toContain("verify-dist: OK");
  });
});

describe("verify-dist executable", () => {
  it.each([
    ["app.js", 'const publicDsn="https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@o1.ingest.sentry.io/1"; globalThis._sentryDebugIds={};', true],
    ["app.js.map", '{"sources":["private/source.ts"]}', false],
    ["app.js", '//# sourceMappingURL=data:application/json;base64,e30=', false],
    ["app.css", '/*# sourceMappingURL=style.css.map */', false],
    ["app.js", 'const token="sntrys_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";', false],
    ["app.js", 'const settings={SENTRY_AUTH_TOKEN:"private-upload-credential"};', false],
    ["app.js", 'const path="/dev/lab";', false],
  ])("checks a %s artifact with expected disposition %s", (name, content, allowed) => {
    const parent = join(repoRoot, "work"); mkdirSync(parent, { recursive: true });
    const fixture = mkdtempSync(join(parent, "dist-guard-"));
    try {
      writeFileSync(join(fixture, name as string), content as string);
      const result = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
      expect(result.status).toBe(allowed ? 0 : 1);
      // Error output names the violated rule, never the matching secret.
      expect(result.stderr).not.toContain("private-upload-credential");
      expect(result.stderr).not.toContain("sntrys_aaaaaaaa");
    } finally { rmSync(fixture, { recursive: true }); }
  });
  it("fails loudly on a missing dist directory", () => {
    expect(() =>
      execFileSync(process.execPath, [script, join(repoRoot, "no-such-dist")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrowError(/Command failed|verify-dist/);
  });
});
