import { expect, test, type Page } from "@playwright/test";
import {
  captureDownload,
  expectJfif240Dpi,
  expectJpegSignature,
  expectSinglePhys240Dpi,
  expectTiffSignature,
  pngAlphaStats,
  zipEntryNames,
  zipFileBytes,
  zipFileText,
} from "./helpers/downloads";
import { EXPORT_DELAY_STORAGE_KEY } from "./helpers/storage";
import {
  activateTool,
  exportPanel,
  freshSampleProject,
  layerRows,
  panel,
  preflightList,
  railButton,
  setCyanAngle,
  statusRegion,
  topbarButton,
} from "./helpers/workstation";

async function openExport(page: Page) {
  await activateTool(page, "export");
  await expect(exportPanel(page)).toBeVisible();
}

async function chooseTarget(
  page: Page,
  target: "Composite" | "Plates" | "Selected Layer",
) {
  await exportPanel(page)
    .getByRole("radiogroup", { name: "Export target" })
    .getByRole("radio", { name: target, exact: true })
    .check();
}

async function chooseFormat(page: Page, group: string, format: string) {
  await exportPanel(page)
    .getByRole("radiogroup", { name: group })
    .getByRole("radio", { name: format, exact: true })
    .check();
}

const exportNow = (page: Page) =>
  exportPanel(page).getByRole("button", { name: "Export Now", exact: true });

test.describe("export — one workflow, two entries", () => {
  test("topbar Export and the rail Preflight/Export tool focus the same workflow", async ({
    page,
  }) => {
    await freshSampleProject(page);

    await topbarButton(page, "Export").click();
    await expect(railButton(page, "export")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(exportPanel(page)).toBeVisible();
    await expect(preflightList(page)).toBeVisible();

    // Leave, then re-enter through the rail: same panel, same workflow.
    await activateTool(page, "layers");
    await expect(exportPanel(page)).toBeHidden();
    await activateTool(page, "export");
    await expect(exportPanel(page)).toBeVisible();
    await expect(preflightList(page)).toBeVisible();
  });
});

test.describe("export — composite formats", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
    await openExport(page);
    await chooseTarget(page, "Composite");
  });

  test("composite PNG downloads with exactly one 240-DPI pHYs chunk", async ({
    page,
  }) => {
    await chooseFormat(page, "Format", "PNG");
    const { filename, bytes } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/-halftone\.png$/);
    expectSinglePhys240Dpi(bytes);
  });

  test("composite JPEG downloads with a JPEG signature and REAL 240-DPI JFIF density", async ({
    page,
  }) => {
    await chooseFormat(page, "Format", "JPEG");
    const { filename, bytes } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/-halftone\.jpg$/);
    expectJpegSignature(bytes);
    // Parse the actual JFIF APP0 bytes — unit 1 (inches), 240 both axes.
    expectJfif240Dpi(bytes);
  });

  test("composite TIFF downloads with a TIFF signature", async ({ page }) => {
    await chooseFormat(page, "Format", "TIFF");
    const { filename, bytes } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/-halftone\.tiff$/);
    expectTiffSignature(bytes);
  });
});

test.describe("export — plate packages", () => {
  test("CMYK raster plate ZIP carries all four visible plates at 240 DPI", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await openExport(page);
    await chooseTarget(page, "Plates");
    await chooseFormat(page, "Plate format", "Raster PNG (ZIP)");

    const { filename, bytes } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/-CMYK-plates\.zip$/);

    const names = await zipEntryNames(bytes);
    const plates = names.filter((name) => name.endsWith(".png"));
    expect(plates).toHaveLength(4);
    for (const letter of ["C", "M", "Y", "K"]) {
      expect(
        plates.some((name) => new RegExp(`(^|[-/])${letter}-plate\\.png$`).test(name)),
        `plate entry for ${letter}`,
      ).toBe(true);
    }
    const kPlate = await zipFileBytes(bytes, /(^|[-/])K-plate\.png$/);
    expectSinglePhys240Dpi(kPlate);
  });

  test("grayscale separation exports only the K plate", async ({ page }) => {
    await freshSampleProject(page);
    await activateTool(page, "plates");
    await panel(page, "plates")
      .getByRole("combobox", { name: "Color mode", exact: true })
      .selectOption("grayscale");

    await openExport(page);
    await chooseTarget(page, "Plates");
    await chooseFormat(page, "Plate format", "Raster PNG (ZIP)");
    const { bytes } = await captureDownload(page, () => exportNow(page).click());

    const plates = (await zipEntryNames(bytes)).filter((name) =>
      name.endsWith(".png"),
    );
    expect(plates).toHaveLength(1);
    expect(/(^|[-/])K-plate\.png$/.test(plates[0])).toBe(true);
  });

  test("vector SVG ZIP is offered only while every layer qualifies, with an explanation otherwise", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await openExport(page);
    await chooseTarget(page, "Plates");

    // The sample project is halftone-mode and vector-eligible.
    const vectorRadio = exportPanel(page)
      .getByRole("radiogroup", { name: "Plate format" })
      .getByRole("radio", { name: "Vector SVG (ZIP)", exact: true });
    await expect(vectorRadio).toBeEnabled();
    await vectorRadio.check();
    const { filename, bytes } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/_SVG_Plates\.zip$/);
    const svgs = (await zipEntryNames(bytes)).filter((name) =>
      name.endsWith(".svg"),
    );
    expect(svgs).toHaveLength(4);
    const kSvg = await zipFileText(bytes, /(^|[-/])K\.svg$/);
    expect(kSvg).toContain("<svg");
    expect(kSvg).toMatch(/<circle|<rect|<path/);
    // Never hide raster inside claimed vector output.
    expect(kSvg).not.toContain("<image");

    // A clean continuous-tone layer disables vector plates with a reason.
    await activateTool(page, "layers");
    await panel(page, "layers")
      .getByRole("radiogroup", { name: "Layer mode" })
      .getByRole("radio", { name: "Clean" })
      .check();
    await openExport(page);
    await chooseTarget(page, "Plates");
    await expect(vectorRadio).toBeDisabled();
    const reason = page.getByTestId("ws-vector-ineligible-reason");
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(/continuous|clean|raster/i);
  });
});

test.describe("export — selected layer", () => {
  test("selected-layer PNG is transparent, full-artboard, and preserves placement", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await activateTool(page, "layers");
    await layerRows(page).first().click();

    await openExport(page);
    await chooseTarget(page, "Selected Layer");
    const first = await captureDownload(page, () => exportNow(page).click());
    expect(first.filename).toMatch(/-layer\.png$/);
    const statsBefore = await pngAlphaStats(page, first.bytes);
    // Transparent PNG, never white-matted: real transparent AND real inked pixels.
    expect(statsBefore.cornerAlphas).toEqual([0, 0, 0, 0]);
    expect(statsBefore.transparentPixelCount).toBeGreaterThan(0);
    expect(statsBefore.opaquePixelCount).toBeGreaterThan(0);
    expect(statsBefore.opaqueBounds).not.toBeNull();

    // Move the layer +200 document px; the export must preserve placement.
    await activateTool(page, "select");
    const transformX = panel(page, "select").getByTestId("numeric-transformX");
    const originalX = Number(await transformX.inputValue());
    await transformX.fill(String(originalX + 200));
    await transformX.press("Enter");

    await openExport(page);
    await chooseTarget(page, "Selected Layer");
    const second = await captureDownload(page, () => exportNow(page).click());
    const statsAfter = await pngAlphaStats(page, second.bytes);

    // Full-artboard bounds are identical…
    expect(statsAfter.width).toBe(statsBefore.width);
    expect(statsAfter.height).toBe(statsBefore.height);
    // …and the ink moved by ~200px (screen lattice quantization allowed).
    const shift =
      statsAfter.opaqueBounds!.minX - statsBefore.opaqueBounds!.minX;
    expect(Math.abs(shift - 200)).toBeLessThanOrEqual(32);
  });

  test("selected-layer TIFF exposes a Layer format choice that persists in the session", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await openExport(page);
    await chooseTarget(page, "Selected Layer");
    await chooseFormat(page, "Layer format", "TIFF");

    // The choice is EXPORT SESSION state: it survives the panel unmounting
    // on a tool switch and re-mounting.
    await activateTool(page, "layers");
    await openExport(page);
    await expect(
      exportPanel(page)
        .getByRole("radiogroup", { name: "Layer format" })
        .getByRole("radio", { name: "TIFF", exact: true }),
    ).toBeChecked();

    const { filename, bytes } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/-layer\.tiff$/);
    expectTiffSignature(bytes);
  });
});

test.describe("export — registration defaults", () => {
  test("registration defaults on for plate packages, off for composite and selected layer, with override", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await openExport(page);
    const registration = exportPanel(page).getByRole("checkbox", {
      name: /Registration marks/i,
    });

    await chooseTarget(page, "Plates");
    await expect(registration).toBeChecked();

    await chooseTarget(page, "Composite");
    await expect(registration).not.toBeChecked();

    await chooseTarget(page, "Selected Layer");
    await expect(registration).not.toBeChecked();

    // Override is honored: a composite export with registration forced on
    // still downloads.
    await chooseTarget(page, "Composite");
    await chooseFormat(page, "Format", "PNG");
    await registration.check();
    const { filename } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/\.png$/);
  });
});

test.describe("export — preflight gates", () => {
  test("hard preflight issues block export entirely", async ({ page }) => {
    await freshSampleProject(page);
    // Hide every layer: nothing printable is a blocking condition.
    await activateTool(page, "layers");
    const rows = layerRows(page);
    const count = await rows.count();
    for (let index = 0; index < count; index++) {
      await rows.nth(index).getByRole("checkbox", { name: /visible/i }).uncheck();
    }

    await openExport(page);
    await expect(
      preflightList(page).locator('[data-severity="block"]'),
    ).not.toHaveCount(0);
    await expect(exportNow(page)).toBeDisabled();
    await expect(page.getByTestId("ws-export-blocked-reason")).toBeVisible();
  });

  test("warnings require explicit confirmation before exporting", async ({
    page,
  }) => {
    await freshSampleProject(page);
    // Duplicate screen angles are a warn-severity press concern (Y defaults 0).
    await setCyanAngle(page, "0");

    await openExport(page);
    await expect(
      preflightList(page).locator('[data-severity="warn"]'),
    ).not.toHaveCount(0);
    await chooseTarget(page, "Composite");
    await chooseFormat(page, "Format", "PNG");

    // Declining the confirmation produces no download.
    await exportNow(page).click();
    const warnings = page.getByRole("dialog", { name: "Review warnings" });
    await expect(warnings).toBeVisible();
    await expect(warnings).toContainText(/angle/i);
    const declined = page
      .waitForEvent("download", { timeout: 1_000 })
      .catch(() => null);
    await warnings.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await declined).toBeNull();

    // Confirming exports.
    const { filename } = await captureDownload(page, async () => {
      await exportNow(page).click();
      await warnings
        .getByRole("button", { name: "Export Anyway", exact: true })
        .click();
    });
    expect(filename).toMatch(/\.png$/);
  });

  test("export shows progress and cancel leaves no partial download", async ({
    page,
  }) => {
    await freshSampleProject(page);
    // Dev-build seam: slow the export pipeline so progress/cancel are
    // deterministically observable (ignored by production builds).
    await page.evaluate(
      (key) => localStorage.setItem(key, "40"),
      EXPORT_DELAY_STORAGE_KEY,
    );

    await openExport(page);
    await chooseTarget(page, "Plates");
    await chooseFormat(page, "Plate format", "Raster PNG (ZIP)");

    const noDownload = page
      .waitForEvent("download", { timeout: 3_000 })
      .catch(() => null);
    await exportNow(page).click();
    await expect(page.getByTestId("ws-export-progress")).toBeVisible();
    await exportPanel(page)
      .getByRole("button", { name: "Cancel Export", exact: true })
      .click();

    await expect(statusRegion(page)).toContainText(/cancel/i);
    await expect(page.getByTestId("ws-export-progress")).toBeHidden();
    expect(await noDownload).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Wave G2 — TRUE STREAMING delivery                                   */
/* ------------------------------------------------------------------ */

/**
 * The streamed path is exercised through a File System Access TEST DOUBLE
 * installed on `window.showSaveFilePicker` (the export flow reads the
 * global at Export Now click time — the documented injection seam), plus
 * the dev-build threshold seam (drglitch.debug.export-stream-threshold-
 * bytes) so small fixtures take the REAL streamed code path end to end.
 */
const STREAM_THRESHOLD_KEY = "drglitch.debug.export-stream-threshold-bytes";

type FsaCaptureState = {
  pickerCalls: number;
  bytes: number;
  firstBytes: number[];
  writes: number;
  closed: boolean;
  aborted: boolean;
};

async function installFsaDouble(page: Page) {
  await page.evaluate(() => {
    const capture: FsaCaptureState = {
      pickerCalls: 0,
      bytes: 0,
      firstBytes: [],
      writes: 0,
      closed: false,
      aborted: false,
    };
    (window as unknown as { __fsaCapture: FsaCaptureState }).__fsaCapture = capture;
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => {
      capture.pickerCalls += 1;
      return {
        createWritable: async () => ({
          write: async (chunk: Uint8Array) => {
            capture.writes += 1;
            capture.bytes += chunk.byteLength ?? 0;
            if (capture.firstBytes.length < 4 && chunk instanceof Uint8Array) {
              for (const byte of chunk.slice(0, 4 - capture.firstBytes.length)) {
                capture.firstBytes.push(byte);
              }
            }
          },
          close: async () => {
            capture.closed = true;
          },
          abort: async () => {
            capture.aborted = true;
          },
        }),
      };
    };
  });
}

function fsaCapture(page: Page): Promise<FsaCaptureState> {
  return page.evaluate(
    () => (window as unknown as { __fsaCapture: FsaCaptureState }).__fsaCapture,
  );
}

test.describe("export — true streaming delivery (wave G2)", () => {
  test("above the threshold, plate ZIPs stream to the FSA writable during render — no Blob download", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await page.evaluate((key) => localStorage.setItem(key, "1024"), STREAM_THRESHOLD_KEY);
    await installFsaDouble(page);
    await openExport(page);
    await chooseTarget(page, "Plates");
    await chooseFormat(page, "Plate format", "Raster PNG (ZIP)");

    const noDownload = page.waitForEvent("download", { timeout: 4_000 }).catch(() => null);
    await exportNow(page).click();
    await expect(statusRegion(page)).toContainText(/exported/i, { timeout: 120_000 });
    const capture = await fsaCapture(page);
    expect(capture.pickerCalls).toBe(1);
    expect(capture.closed).toBe(true);
    expect(capture.aborted).toBe(false);
    expect(capture.writes).toBeGreaterThan(1); // chunked, not one Blob
    expect(capture.bytes).toBeGreaterThan(1024);
    // The streamed archive starts with the ZIP local-header signature.
    expect(capture.firstBytes.slice(0, 2)).toEqual([0x50, 0x4b]);
    expect(await noDownload).toBeNull();
  });

  test("cancel mid-stream aborts the writable (transactional discard) and never closes or downloads", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await page.evaluate((key) => localStorage.setItem(key, "1024"), STREAM_THRESHOLD_KEY);
    // Slow every render step/band so the cancel deterministically lands
    // mid-stream (the same dev seam the buffered cancel test uses).
    await page.evaluate(
      (key) => localStorage.setItem(key, "40"),
      EXPORT_DELAY_STORAGE_KEY,
    );
    await installFsaDouble(page);
    await openExport(page);
    await chooseTarget(page, "Plates");
    await chooseFormat(page, "Plate format", "Raster PNG (ZIP)");

    const noDownload = page.waitForEvent("download", { timeout: 3_000 }).catch(() => null);
    await exportNow(page).click();
    await expect(page.getByTestId("ws-export-progress")).toBeVisible();
    await exportPanel(page)
      .getByRole("button", { name: "Cancel Export", exact: true })
      .click();
    await expect(statusRegion(page)).toContainText(/cancel/i);
    await expect(page.getByTestId("ws-export-progress")).toBeHidden();
    const capture = await fsaCapture(page);
    expect(capture.pickerCalls).toBe(1);
    expect(capture.closed).toBe(false); // never finalize a cancelled export
    expect(capture.aborted).toBe(true);
    expect(await noDownload).toBeNull();
  });

  test("above the threshold WITHOUT File System Access, the export blocks BEFORE any render", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await page.evaluate((key) => localStorage.setItem(key, "1024"), STREAM_THRESHOLD_KEY);
    await page.evaluate(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await openExport(page);
    await chooseTarget(page, "Plates");
    await chooseFormat(page, "Plate format", "Raster PNG (ZIP)");

    const noDownload = page.waitForEvent("download", { timeout: 2_500 }).catch(() => null);
    await expect(exportNow(page)).toBeDisabled();
    await expect(page.getByTestId("ws-export-blocked-reason")).toContainText(/memory|stream/i);
    await expect(page.getByTestId("ws-export-progress")).toHaveCount(0);
    expect(await noDownload).toBeNull();
  });

  test("small exports keep the buffered Blob path byte-for-byte and never touch the picker", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await installFsaDouble(page); // present but must stay untouched
    await openExport(page);
    await chooseTarget(page, "Composite");
    await chooseFormat(page, "Format", "PNG");
    const { filename, bytes } = await captureDownload(page, () =>
      exportNow(page).click(),
    );
    expect(filename).toMatch(/-halftone\.png$/);
    expectSinglePhys240Dpi(bytes);
    const capture = await fsaCapture(page);
    expect(capture.pickerCalls).toBe(0);
    expect(capture.writes).toBe(0);
  });
});
