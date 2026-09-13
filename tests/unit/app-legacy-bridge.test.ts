/**
 * Legacy bridge: ProjectCoreV1 <-> legacy studio shapes. The read direction
 * (halftoneSettingsFromCore) is covered by the export suite; these tests pin
 * the write direction — legacy setting keys to canonical commands — and the
 * DocumentSettings projection.
 */
import { describe, expect, it } from "vitest";
import {
  assetExtForMime,
  commandsForDocumentPatch,
  commandsForSetting,
  documentFromCore,
  glitchIsActive,
  sheetForArtboard,
} from "../../src/app/legacy-bridge";
import { applyCommand, createEmptyProjectCore, createLayerFromAsset } from "../../src/project";
import type { LayerV1, ProjectCoreV1 } from "../../src/core/types";

function coreWithLayer(): { core: ProjectCoreV1; layer: LayerV1 } {
  let core = createEmptyProjectCore();
  const layer = createLayerFromAsset("a".repeat(64), "art.png", { width: 800, height: 600 }, core.artboard);
  core = applyCommand(core, { type: "layer/add", layer });
  return { core, layer: core.layers[0] };
}

describe("documentFromCore", () => {
  it("projects artboard, scale, and mirror onto DocumentSettings", () => {
    const { core, layer } = coreWithLayer();
    const settings = documentFromCore(core, layer);
    expect(settings.sheetSize).toBe("11x15");
    expect(settings.orientation).toBe("portrait");
    expect(settings.scalePercent).toBe(100);
    expect(settings.mirrorImage).toBe(false);
    expect(settings.background).toBe("white");
  });

  it("reads mirror direction from flipH/flipV and scale from the transform", () => {
    const { core, layer } = coreWithLayer();
    const flipped = applyCommand(core, {
      type: "layer/set-transform",
      layerId: layer.id,
      patch: { flipV: true, scale: { x: 0.5, y: 0.5 } },
    });
    const settings = documentFromCore(flipped, flipped.layers[0]);
    expect(settings.mirrorImage).toBe(true);
    expect(settings.mirrorDirection).toBe("vertical");
    expect(settings.scalePercent).toBe(50);
  });

  it("derives orientation from artboard dimensions", () => {
    const core = createEmptyProjectCore({ widthPx: 3600, heightPx: 2640, presetId: "11x15" });
    expect(sheetForArtboard(core.artboard)).toEqual({
      sheetSize: "11x15",
      orientation: "landscape",
    });
  });
});

describe("commandsForSetting", () => {
  it("routes halftone keys to a recipe/update-halftone patch", () => {
    const { core, layer } = coreWithLayer();
    expect(commandsForSetting(core, layer, "cellSize", 24)).toEqual([
      { type: "recipe/update-halftone", layerId: layer.id, patch: { cellSize: 24 } },
    ]);
  });

  it("keeps both recipe inverts in step for the legacy invert toggle", () => {
    const { core, layer } = coreWithLayer();
    const commands = commandsForSetting(core, layer, "invert", true);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.type).sort()).toEqual([
      "recipe/update-diffusion",
      "recipe/update-halftone",
    ]);
  });

  it("maps grayscale to the document-global separation mode", () => {
    const { core, layer } = coreWithLayer();
    expect(commandsForSetting(core, layer, "grayscale", true)).toEqual([
      { type: "separation/set-mode", mode: "grayscale" },
    ]);
  });

  it("maps diffusionEnabled to a single undoable layer mode switch", () => {
    const { core, layer } = coreWithLayer();
    expect(commandsForSetting(core, layer, "diffusionEnabled", true)).toEqual([
      { type: "layer/set-mode", layerId: layer.id, mode: "diffusion" },
    ]);
    expect(commandsForSetting(core, layer, "diffusionEnabled", false)).toEqual([
      { type: "layer/set-mode", layerId: layer.id, mode: "halftone" },
    ]);
  });

  it("renames diffusion keys onto the recipe field names", () => {
    const { core, layer } = coreWithLayer();
    expect(commandsForSetting(core, layer, "diffusionReset", 0.4)).toEqual([
      { type: "recipe/update-diffusion", layerId: layer.id, patch: { reset: 0.4 } },
    ]);
  });

  it("marks the glitch pass enabled exactly when an amount is live", () => {
    const { core, layer } = coreWithLayer();
    const [amount] = commandsForSetting(core, layer, "sliceShift", 12);
    expect(amount).toMatchObject({
      type: "recipe/update-glitch",
      patch: { sliceShift: 12, enabled: true },
    });
    // A size-style parameter alone never turns the pass on.
    const [param] = commandsForSetting(core, layer, "sliceSize", 32);
    expect(param).toMatchObject({
      type: "recipe/update-glitch",
      patch: { sliceSize: 32, enabled: false },
    });
    expect(glitchIsActive({ ...layer.recipe.glitch, sliceShift: 1 })).toBe(true);
    expect(glitchIsActive(layer.recipe.glitch)).toBe(false);
  });

  it("diffs plate angle records into per-plate commands", () => {
    const { core, layer } = coreWithLayer();
    const commands = commandsForSetting(core, layer, "angles", {
      cyan: 33,
      magenta: 75,
      yellow: 0,
      black: 45,
    });
    expect(commands).toEqual([{ type: "separation/set-angle", plate: "cyan", angle: 33 }]);
  });

  it("returns no commands for layer keys without a layer", () => {
    const { core } = coreWithLayer();
    expect(commandsForSetting(core, null, "cellSize", 24)).toEqual([]);
  });
});

describe("commandsForDocumentPatch", () => {
  it("resizes the artboard for sheet/orientation changes", () => {
    const { core, layer } = coreWithLayer();
    const commands = commandsForDocumentPatch(core, layer, { orientation: "landscape" });
    expect(commands).toEqual([
      { type: "artboard/resize", widthPx: 3600, heightPx: 2640, presetId: "11x15" },
    ]);
  });

  it("maps scale and mirror onto the primary layer transform", () => {
    const { core, layer } = coreWithLayer();
    const commands = commandsForDocumentPatch(core, layer, {
      scalePercent: 50,
      mirrorImage: true,
      mirrorDirection: "horizontal",
    });
    expect(commands).toEqual([
      {
        type: "layer/set-transform",
        layerId: layer.id,
        patch: { scale: { x: 0.5, y: 0.5 }, flipH: true, flipV: false },
      },
    ]);
  });

  it("round-trips: applying the commands reproduces the requested settings", () => {
    const { core, layer } = coreWithLayer();
    let next = core;
    for (const command of commandsForDocumentPatch(core, layer, {
      orientation: "landscape",
      scalePercent: 200,
      background: "black",
    })) {
      next = applyCommand(next, command);
    }
    const settings = documentFromCore(next, next.layers[0]);
    expect(settings.orientation).toBe("landscape");
    expect(settings.scalePercent).toBe(200);
    expect(settings.background).toBe("black");
  });
});

describe("assetExtForMime", () => {
  it("maps stored mimes to .drglitch asset extensions", () => {
    expect(assetExtForMime("image/png")).toBe("png");
    expect(assetExtForMime("image/jpeg")).toBe("jpg");
    expect(assetExtForMime("image/webp")).toBe("webp");
    expect(assetExtForMime("image/svg+xml")).toBe("svg");
  });
});

describe("resetOutputCommands (canonical output ownership)", () => {
  it("resets ONLY canonical output + mark geometry — never layer recipes or opacity", async () => {
    const { resetOutputCommands } = await import("../../src/app/legacy-bridge");
    const commands = resetOutputCommands();
    expect(commands).toEqual([
      {
        type: "output/update",
        patch: {
          polarity: "positive",
          pressMirror: false,
          registrationOnPlates: true,
          registrationOnComposite: false,
        },
      },
      {
        type: "registration/update",
        patch: { size: 120, offset: 120, weight: 2, mode: "corners" },
      },
    ]);
    // Guard the P0 contract explicitly: no layer-targeted command types.
    for (const command of commands) {
      expect(command.type.startsWith("layer/")).toBe(false);
      expect(command.type.startsWith("recipe/")).toBe(false);
    }
  });

  it("applying the reset restores factory output without touching layers", async () => {
    const { core } = coreWithLayer();
    let next = applyCommand(core, {
      type: "output/update",
      patch: { polarity: "negative", pressMirror: true, registrationOnPlates: false },
    });
    next = applyCommand(next, {
      type: "recipe/update-halftone",
      layerId: next.layers[0].id,
      patch: { invert: true },
    });
    const before = next.layers;
    let after = next;
    const { resetOutputCommands } = await import("../../src/app/legacy-bridge");
    for (const command of resetOutputCommands()) after = applyCommand(after, command);
    expect(after.output).toEqual({
      polarity: "positive",
      pressMirror: false,
      registrationOnPlates: true,
      registrationOnComposite: false,
    });
    // Layer recipes/opacity untouched (recipe invert survives the reset).
    expect(after.layers).toBe(before);
    expect(after.layers[0].recipe.halftone.invert).toBe(true);
  });
});
