import type { Page } from "@playwright/test";

/**
 * Headless UI tests inspect downloads. Bridge the native OS save dialog to
 * a transactional test sink whose close exposes the completed bytes as a
 * download. Explicit test doubles and browsers without FSA stay unchanged.
 * This is a picker simulation; the performance harness separately tests
 * actual OPFS writes, memory and cancellation.
 */
export async function bridgeNativeSavePicker(page: Page): Promise<void> {
  function install() {
    const host = window as unknown as { showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<unknown> };
    if (!host.showSaveFilePicker || !Function.prototype.toString.call(host.showSaveFilePicker).includes("[native code]")) return;
    host.showSaveFilePicker = async (options) => ({
      async createWritable() {
        let chunks: BlobPart[] = [];
        let terminal = false;
        return {
          async write(chunk: Uint8Array) {
            if (terminal) throw new DOMException("Closed", "InvalidStateError");
            chunks.push(chunk.slice());
          },
          async close() {
            if (terminal) throw new DOMException("Closed", "InvalidStateError");
            terminal = true;
            const url = URL.createObjectURL(new Blob(chunks));
            chunks = [];
            const anchor = document.createElement("a");
            anchor.href = url; anchor.download = options?.suggestedName ?? "export";
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
          async abort() { terminal = true; chunks = []; },
        };
      },
    });
  }
  await page.addInitScript(install);
  await page.evaluate(install);
}
