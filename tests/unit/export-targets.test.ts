import { describe, expect, it } from "vitest";
import type { ArtboardV1, OutputDefaultsV1 } from "../../src/core/types";
import {
  contributingPlates,
  exportBaseName,
  exportBounds,
  formatExtension,
  formatMime,
  formatSupportsAlpha,
  plateFileName,
  plateSettingsFileName,
  resolveMatte,
  resolveRegistration,
  svgPlateFolderName,
  targetFileName,
  targetIsTransparent,
  type ExportTarget,
} from "../../src/export/targets";

const output: OutputDefaultsV1 = {
  polarity: "positive",
  pressMirror: false,
  registrationOnPlates: true,
  registrationOnComposite: false,
};

const artboard = (background: ArtboardV1["background"]): ArtboardV1 => ({
  widthPx: 2640,
  heightPx: 3600,
  presetId: "11x15",
  background,
});

const compositePng: ExportTarget = { kind: "composite", format: "png" };
const compositeJpeg: ExportTarget = { kind: "composite", format: "jpeg" };
const compositeTiff: ExportTarget = { kind: "composite", format: "tiff" };
const platePng: ExportTarget = { kind: "plate-package", format: "png" };
const plateSvg: ExportTarget = { kind: "plate-package", format: "svg" };
const selected: ExportTarget = { kind: "selected-layer", format: "png", layerId: "layer-1" };

describe("registration defaults per target", () => {
  it("defaults ON for plate packages and OFF for composite/selected", () => {
    expect(resolveRegistration(platePng, output)).toBe(true);
    expect(resolveRegistration(plateSvg, output)).toBe(true);
    expect(resolveRegistration(compositePng, output)).toBe(false);
    expect(resolveRegistration(selected, output)).toBe(false);
  });

  it("follows the document output defaults", () => {
    const flipped = { ...output, registrationOnPlates: false, registrationOnComposite: true };
    expect(resolveRegistration(platePng, flipped)).toBe(false);
    expect(resolveRegistration(compositePng, flipped)).toBe(true);
    // Selected-layer exports never inherit a document default.
    expect(resolveRegistration(selected, flipped)).toBe(false);
  });

  it("lets an explicit target override win in both directions", () => {
    expect(resolveRegistration({ ...platePng, registration: false }, output)).toBe(false);
    expect(resolveRegistration({ ...compositePng, registration: true }, output)).toBe(true);
    expect(resolveRegistration({ ...selected, registration: true }, output)).toBe(true);
  });
});

describe("bounds, alpha, and matte", () => {
  it("always exports the full artboard", () => {
    expect(exportBounds(artboard("white"))).toEqual({ width: 2640, height: 3600 });
  });

  it("reports alpha support per format", () => {
    expect(formatSupportsAlpha("png")).toBe(true);
    expect(formatSupportsAlpha("tiff")).toBe(true);
    expect(formatSupportsAlpha("svg")).toBe(true);
    expect(formatSupportsAlpha("jpeg")).toBe(false);
  });

  it("mattes JPEG composites with the proof background", () => {
    expect(resolveMatte(compositeJpeg, artboard("white"))).toBe("#ffffff");
    expect(resolveMatte(compositeJpeg, artboard("black"))).toBe("#000000");
    // JPEG cannot keep alpha: a transparent background mattes white.
    expect(resolveMatte(compositeJpeg, artboard("transparent"))).toBe("#ffffff");
  });

  it("mattes alpha-capable composites only for opaque backgrounds", () => {
    expect(resolveMatte(compositePng, artboard("white"))).toBe("#ffffff");
    expect(resolveMatte(compositeTiff, artboard("black"))).toBe("#000000");
    expect(resolveMatte(compositePng, artboard("transparent"))).toBeNull();
  });

  it("keeps plate packages and selected layers transparent regardless of background", () => {
    expect(resolveMatte(platePng, artboard("black"))).toBeNull();
    expect(resolveMatte(plateSvg, artboard("white"))).toBeNull();
    expect(resolveMatte(selected, artboard("black"))).toBeNull();
    expect(targetIsTransparent(selected, artboard("black"))).toBe(true);
    expect(targetIsTransparent(compositeJpeg, artboard("transparent"))).toBe(false);
    expect(targetIsTransparent(compositePng, artboard("transparent"))).toBe(true);
  });
});

describe("plates and naming", () => {
  it("selects contributing plates by mode and visibility", () => {
    expect(
      contributingPlates({
        mode: "cmyk",
        angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
        visible: { cyan: true, magenta: false, yellow: true, black: true },
      }),
    ).toEqual(["cyan", "yellow", "black"]);
    expect(
      contributingPlates({
        mode: "grayscale",
        angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
        visible: { cyan: true, magenta: true, yellow: true, black: true },
      }),
    ).toEqual(["black"]);
  });

  it("builds filesystem-safe base names BYTE-FOR-BYTE as shipped cleanName", () => {
    // Shipped algorithm (git HEAD HalftoneStudio.tsx cleanName): strip ONE
    // trailing dot-segment, replace each run of other characters with a
    // single "-", lowercase — NO collapsing, NO trimming. Every expectation
    // below is the value the shipped code produced (computed from the
    // legacy regex chain), not what looks tidy.
    const shippedCleanName = (name: string) =>
      name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
    const oracles: Array<[string, string]> = [
      // The historical oracle the migrated legacy specs depend on.
      ["DR.GLITCH sample artwork", "dr"],
      // Repeated/multiple dots: only the LAST segment strips.
      ["photo.final.png", "photo-final"],
      // Uppercase + extension casing.
      ["UPPER Case.PNG", "upper-case"],
      // Leading/trailing separators SURVIVE (no trim in shipped code).
      ["  Print / Loud!! ", "-print-loud-"],
      ["-name-.png", "-name-"],
      // Unicode runs collapse to one hyphen per run.
      ["café Ø.png", "caf-"],
      // All-symbols: one run, one hyphen — the shipped output, kept exact.
      ["///", "-"],
      ["###", "-"],
      // Repeated punctuation between words: one hyphen per run, uncollapsed
      // ONLY across separate runs ("a--b" has one run of two chars).
      ["a--b!!c.png", "a--b-c"],
    ];
    for (const [input, expected] of oracles) {
      expect(shippedCleanName(input)).toBe(expected); // the oracle itself
      expect(exportBaseName(input)).toBe(expected);
    }
    // The ONLY deliberate extension beyond shipped behavior: an empty
    // result falls back to "untitled" (shipped code never saw empty names).
    expect(exportBaseName("")).toBe("untitled");
    expect(exportBaseName(".png")).toBe("untitled");
  });

  it("names artifacts exactly as the shipped studio did", () => {
    // Composite: <base>-halftone.<ext>
    expect(targetFileName(compositeTiff, "Print Loud", "cmyk")).toBe("print-loud-halftone.tiff");
    expect(targetFileName(compositeJpeg, "Print Loud", "cmyk")).toBe("print-loud-halftone.jpg");
    // Raster plate package: mode-dependent ZIP name, root-level plate entries.
    expect(targetFileName(platePng, "Print Loud", "cmyk")).toBe("print-loud-CMYK-plates.zip");
    expect(targetFileName(platePng, "Print Loud", "grayscale")).toBe("print-loud-K-plates.zip");
    expect(plateFileName("Print Loud", "black", "png")).toBe("print-loud-K-plate.png");
    expect(plateSettingsFileName("Print Loud", "png")).toBe("job-settings.json");
    // Vector plate package: folder-shaped ZIP with entries inside the folder.
    expect(svgPlateFolderName("Print Loud")).toBe("print-loud_SVG_Plates");
    expect(targetFileName(plateSvg, "Print Loud", "cmyk")).toBe("print-loud_SVG_Plates.zip");
    expect(plateFileName("Print Loud", "magenta", "svg")).toBe("print-loud_SVG_Plates/M.svg");
    expect(plateSettingsFileName("Print Loud", "svg")).toBe("print-loud_SVG_Plates/job-settings.json");
    // Selected layer is new to the workstation: coverage-map contract.
    expect(targetFileName(selected, "Print Loud", "cmyk")).toBe("print-loud-layer.png");
  });

  it("exposes consistent format metadata", () => {
    expect(formatMime("png")).toBe("image/png");
    expect(formatMime("jpeg")).toBe("image/jpeg");
    expect(formatMime("tiff")).toBe("image/tiff");
    expect(formatMime("svg")).toBe("image/svg+xml");
    expect(formatExtension("jpeg")).toBe("jpg");
  });
});
