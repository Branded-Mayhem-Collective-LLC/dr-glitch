import { expect, test } from "@playwright/test";
import * as policy from "../../src/telemetry/sentry";
// @ts-expect-error The executable canary guard is an ESM JavaScript module.
import { validateTelemetryApproval, validateTelemetryEnvelope } from "../../scripts/telemetry-canary-guard.mjs";

test("the real Sentry SDK emits sanitized errors and manual application traces", async ({ page }) => {
  const envelopes: string[] = [];
  // Local transport interception: this proof never contacts Sentry.
  await page.route("https://o1.ingest.sentry.io/**", async (route) => {
    envelopes.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, body: "{}", headers: { "access-control-allow-origin": "*" } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const telemetry = await load("/src/telemetry/sentry.ts");
    await telemetry.initTelemetry({ env: {
      dsn: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@o1.ingest.sentry.io/1",
      release: "a".repeat(40), environment: "private-validation", privateValidation: true,
    } });
    const finish = telemetry.startAppSpan("app.export", { layerCount: 8, pixelCount: 19_000_000 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    finish();
    const error = new Error("private-customer-logo.svg");
    error.name = "private-customer-logo.svg";
    telemetry.captureHandledError("telemetry-validation", error);
  });
  await expect.poll(() => envelopes.length).toBeGreaterThanOrEqual(2);
  const events = envelopes.flatMap((body) => body.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }));
  expect(events.some((event) => event.type === "transaction" && event.transaction === "app.export")).toBe(true);
  expect(events.some((event) => event.exception?.values?.[0]?.value === "telemetry-validation")).toBe(true);
  const payload = JSON.stringify(events);
  expect(payload).not.toContain("private-customer-logo");
  expect(payload).not.toContain("127.0.0.1");
  expect(payload).not.toContain("ui.click");
  const approval = validateTelemetryApproval({ releaseSha: "a".repeat(40), telemetryValidationAuthorized: true,
    publicDsn: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@o1.ingest.sentry.io/1", environment: "private-validation", maxEnvelopes: 16 }, "a".repeat(40));
  for (const body of envelopes) expect(validateTelemetryEnvelope(body, approval, policy).eventId).toMatch(/^[a-f0-9]{32}$/);
});
