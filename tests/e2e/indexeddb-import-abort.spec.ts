import { expect, test } from "@playwright/test";

test("native IndexedDB abort rolls back import installation and preserves existing work", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/e2e/harness.html");
  const receipt = await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const { IdbBackend } = await load("/src/storage/backend.ts");
    const { StorageStagingSink } = await load("/src/storage/import-sink.ts");
    const { createEmptyProject, createLayerFromAsset } = await load("/src/project/factory.ts");
    const { sha256Hex } = await load("/src/io/sha256.ts");
    const backend = await IdbBackend.open();
    try {
      const existing = createEmptyProject();
      await backend.put("projects", existing.id, existing);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 8;
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      canvas.width = canvas.height = 0;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = await sha256Hex(bytes);
      const envelope = createEmptyProject();
      envelope.core.layers.push(createLayerFromAsset(sha256, "Imported artwork", { width: 8, height: 8 }, envelope.core.artboard));
      const controller = new AbortController();
      const transaction = backend.transaction.bind(backend);
      backend.transaction = (stores: string[], work: (tx: unknown) => Promise<void>, signal?: AbortSignal) => transaction(stores, async (tx: { put: (...args: unknown[]) => Promise<void> }) => work({
        ...tx,
        put: async (store: string, key: string, value: unknown) => {
          await tx.put(store, key, value);
          if (store === "projects" && key === envelope.id) controller.abort();
        },
      }), signal);
      const sink = new StorageStagingSink(backend);
      await sink.allocate();
      await sink.write({ sha256, kind: "raster", mime: "image/png", byteLength: bytes.length, width: 8, height: 8, createdAt: 1 }, bytes);
      let rejected = false;
      try { await sink.commit(envelope, controller.signal); } catch { rejected = true; }
      await sink.abort("cancelled");
      return { rejected, installed: sink.installed, projects: await backend.getAllKeys("projects"),
        preserved: JSON.stringify(await backend.get("projects", existing.id)) === JSON.stringify(existing),
        existingId: existing.id, assets: await backend.getAllKeys("assets"), staging: await backend.getAllKeys("staging") };
    } finally { backend.close(); }
  });
  expect(receipt.rejected).toBe(true);
  expect(receipt.installed).toBeNull();
  expect(receipt.preserved).toBe(true);
  expect(receipt.projects).toEqual([receipt.existingId]);
  expect(receipt.assets).toEqual([]);
  expect(receipt.staging).toEqual([]);
  expect(errors).toEqual([]);
});
