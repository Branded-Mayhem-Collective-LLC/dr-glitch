import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the DRC Halftone workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>DRC Halftone — CMYK Studio<\/title>/i);
  assert.match(html, /DRC Halftone/);
  assert.match(html, /Build your separation/);
  assert.match(html, /Live browser preview/);
  assert.match(html, /Composite proof/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("ships the functional browser engine and export workflow", async () => {
  const [studio, engine, layout] = await Promise.all([
    readFile(
      new URL("../app/components/HalftoneStudio.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/halftone.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(studio, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(studio, /exportArtwork\("composite"\)/);
  assert.match(studio, /exportArtwork\("plates"\)/);
  assert.match(studio, /new JSZip\(\)/);
  assert.match(engine, /export function renderHalftone/);
  assert.match(engine, /globalCompositeOperation = monochrome \? "source-over" : "multiply"/);
  assert.match(engine, /cyan: 15|settings\.angles/);
  assert.match(layout, /url: "\/og\.png"/);
});
