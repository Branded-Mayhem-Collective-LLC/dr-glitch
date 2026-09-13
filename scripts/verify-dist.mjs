#!/usr/bin/env node
/** Verify deploy artifacts: public DSN/release/debug IDs are allowed;
 * source maps, private upload credentials and development routes are not. */

import console from "node:console";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import process from "node:process";

const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".svg", ".txt", ".webmanifest",
]);

const CONTENT_RULES = [
  { name: "sentry-auth-token", pattern: /sntrys_[A-Za-z0-9_-]{16,}|sntryu_[A-Za-z0-9_-]{16,}/ },
  { name: "assigned-auth-secret", pattern: /(?:SENTRY_AUTH_TOKEN|VITE_[A-Z_]*(?:TOKEN|SECRET))["']?\s*[:=]\s*["'][^"']+["']/ },
  { name: "external-sourcemap-reference", pattern: /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=[^\s]+/ },
  { name: "dev-component-lab", pattern: /\/dev\/lab|ComponentLab/ },
  { name: "dev-debug-seam", pattern: /drglitch\.debug\.(?:export-tile-delay-ms|simulate-quota)/ },
];

/** File-name patterns that must never be emitted. */
const FILENAME_RULES = [
  { name: "source-map-file", pattern: /\.map$/i },
  { name: "dev-lab-chunk", pattern: /component[-_]?lab/i },
  { name: "sentry-upload-artifact", pattern: /\.sentryclirc|sentry\.properties/i },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

export function verifyDist(distDir) {
  const violations = [];
  if (!existsSync(distDir)) {
    return { ok: false, violations: [`dist directory not found: ${distDir}`] };
  }
  for (const file of walk(distDir)) {
    const rel = relative(distDir, file);
    for (const rule of FILENAME_RULES) {
      if (rule.pattern.test(rel)) violations.push(`${rule.name}: ${rel}`);
    }
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const content = readFileSync(file, "utf8");
    for (const rule of CONTENT_RULES) {
      const match = rule.pattern.exec(content);
      if (match) {
        violations.push(
          `${rule.name}: ${rel}`,
        );
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  const distDir = process.argv[2] ?? join(process.cwd(), "dist");
  const { ok, violations } = verifyDist(distDir);
  if (ok) {
    console.log(`verify-dist: OK — ${distDir} carries no public maps, auth secrets, upload credentials, or dev chunks.`);
  } else {
    console.error("verify-dist: FAILED");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
  }
}
