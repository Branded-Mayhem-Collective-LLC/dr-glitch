import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

test("release guest canary completes against the private local workstation", async () => {
  test.setTimeout(300_000);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/guest-canary.mjs", "--rehearsal-worktree"],
    { cwd: root, timeout: 290_000, maxBuffer: 1024 * 1024 });
  await test.info().attach("guest-canary-output", { body: stdout, contentType: "text/plain" });
  const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(receipt.status).toBe("passed");
  expect(receipt.checks).toBeGreaterThanOrEqual(17);
});
