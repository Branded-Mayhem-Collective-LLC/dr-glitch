/**
 * Artwork intake intent — Add vs Replace stack semantics (wave F item:
 * separate flows BEFORE async intake, captured immutable intent, 32-layer
 * cap with a clear error).
 */
import { describe, expect, it } from "vitest";
import {
  artworkIntakeCommands,
  layerCapError,
} from "../../src/app/artwork-intake";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { ProjectCoreV1 } from "../../src/core/types";
import {
  applyCommand,
  createEmptyProjectCore,
  createLayerFromAsset,
} from "../../src/project";

function coreWithLayers(count: number): ProjectCoreV1 {
  let core = createEmptyProjectCore();
  for (let index = 0; index < count; index += 1) {
    const layer = createLayerFromAsset(
      String(index).padStart(64, "0"),
      `layer-${index}.png`,
      { width: 100, height: 100 },
      core.artboard,
    );
    core = applyCommand(core, { type: "layer/add", layer });
  }
  return core;
}

function newLayer(core: ProjectCoreV1) {
  return createLayerFromAsset(
    "f".repeat(64),
    "incoming.png",
    { width: 64, height: 64 },
    core.artboard,
  );
}

describe("artworkIntakeCommands — add", () => {
  it("adds on top and preserves every existing layer", () => {
    const core = coreWithLayers(3);
    const layer = newLayer(core);
    const result = artworkIntakeCommands(core, { mode: "add" }, layer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.commands.reduce(applyCommand, core);
    expect(next.layers).toHaveLength(4);
    expect(next.layers.slice(0, 3)).toEqual(core.layers);
    expect(next.layers[3].id).toBe(layer.id);
  });

  it("new added layers are Clean mode with Glitch off (factory contract)", () => {
    const core = coreWithLayers(1);
    const layer = newLayer(core);
    expect(layer.recipe.mode).toBe("clean");
    expect(layer.recipe.glitch.enabled).toBe(false);
  });

  it("enforces the layer cap with a clear error instead of a silent no-op", () => {
    const core = coreWithLayers(RESOURCE_POLICY.maxLayers);
    const result = artworkIntakeCommands(core, { mode: "add" }, newLayer(core));
    expect(result).toEqual({ ok: false, error: layerCapError() });
    expect(layerCapError()).toContain(String(RESOURCE_POLICY.maxLayers));
  });
});

describe("artworkIntakeCommands — replace", () => {
  it("replaces the captured target at its stack position", () => {
    const core = coreWithLayers(3);
    const target = core.layers[1];
    const layer = newLayer(core);
    const result = artworkIntakeCommands(
      core,
      { mode: "replace", targetLayerId: target.id },
      layer,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.commands.reduce(applyCommand, core);
    expect(next.layers).toHaveLength(3);
    expect(next.layers.map(({ id }) => id)).toEqual([
      core.layers[0].id,
      layer.id,
      core.layers[2].id,
    ]);
  });

  it("captured intent survives a stack change: a departed target degrades to add", () => {
    // The intent froze layer B; B was deleted while the picker was open.
    const core = coreWithLayers(2);
    const departedId = "gone-" + "0".repeat(59);
    const layer = newLayer(core);
    const result = artworkIntakeCommands(
      core,
      { mode: "replace", targetLayerId: departedId },
      layer,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.commands.reduce(applyCommand, core);
    expect(next.layers).toHaveLength(3);
    expect(next.layers[2].id).toBe(layer.id);
  });

  it("replace with no prior layer (empty project) is a plain add", () => {
    const core = coreWithLayers(0);
    const layer = newLayer(core);
    const result = artworkIntakeCommands(
      core,
      { mode: "replace", targetLayerId: null },
      layer,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.commands.reduce(applyCommand, core);
    expect(next.layers.map(({ id }) => id)).toEqual([layer.id]);
  });

  it("replace at the cap still succeeds (net layer count is unchanged)", () => {
    const core = coreWithLayers(RESOURCE_POLICY.maxLayers);
    const target = core.layers[0];
    const layer = newLayer(core);
    const result = artworkIntakeCommands(
      core,
      { mode: "replace", targetLayerId: target.id },
      layer,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.commands.reduce(applyCommand, core);
    expect(next.layers).toHaveLength(RESOURCE_POLICY.maxLayers);
    expect(next.layers[0].id).toBe(layer.id);
  });
});
