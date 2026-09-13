/**
 * Pure project reducer: (core, command) => core.
 *
 * Invariants:
 * - Never mutates the input core; untouched branches keep referential identity.
 * - Never throws for well-typed commands: invalid input (bad quad, oversized
 *   artboard, unknown layer id, layer cap) returns the prior core unchanged,
 *   except transform patches where only the invalid field keeps its prior
 *   value while valid fields still apply.
 */
import { RESOURCE_POLICY } from "../core/resource-policy";
import type {
  CropV1,
  GuidesV1,
  Id,
  LayerV1,
  PerspectiveQuadV1,
  ProjectCoreV1,
  TransformV1,
  Vec2,
} from "../core/types";
import type { Command, GuideAxis, TransformPatch } from "./commands";

/** Quads whose shoelace area falls below this (document px^2) are degenerate. */
const MIN_QUAD_AREA = 1e-3;

function isFiniteVec(v: Vec2): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y);
}

/**
 * Validates a non-null perspective quad: four finite corners ordered
 * TL, TR, BR, BL forming a strictly convex, non-self-intersecting,
 * non-near-zero-area polygon. Strict convexity of an ordered quad also
 * guarantees a non-singular homography.
 */
export function isValidPerspectiveQuad(quad: NonNullable<PerspectiveQuadV1>): boolean {
  if (!Array.isArray(quad) || quad.length !== 4) return false;
  for (const corner of quad) {
    if (!corner || !isFiniteVec(corner)) return false;
  }
  let area = 0;
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const p0 = quad[i];
    const p1 = quad[(i + 1) % 4];
    const p2 = quad[(i + 2) % 4];
    area += p0.x * p1.y - p1.x * p0.y;
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (cross === 0) return false;
    const crossSign = Math.sign(cross);
    if (sign === 0) sign = crossSign;
    else if (crossSign !== sign) return false; // concave or self-intersecting
  }
  return Math.abs(area) / 2 >= MIN_QUAD_AREA;
}

function cloneQuad(quad: NonNullable<PerspectiveQuadV1>): NonNullable<PerspectiveQuadV1> {
  return [
    { x: quad[0].x, y: quad[0].y },
    { x: quad[1].x, y: quad[1].y },
    { x: quad[2].x, y: quad[2].y },
    { x: quad[3].x, y: quad[3].y },
  ];
}

function pickVec(candidate: Vec2 | undefined, prior: Vec2): Vec2 {
  return candidate && isFiniteVec(candidate) ? { x: candidate.x, y: candidate.y } : prior;
}

function pickNumber(candidate: number | undefined, prior: number): number {
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : prior;
}

function pickBoolean(candidate: boolean | undefined, prior: boolean): boolean {
  return typeof candidate === "boolean" ? candidate : prior;
}

/**
 * Applies a transform patch, keeping prior values for absent or invalid
 * fields. An invalid perspective quad keeps the prior valid perspective
 * without blocking the rest of the patch.
 */
export function sanitizeTransform(prior: TransformV1, patch: TransformPatch): TransformV1 {
  let perspective = prior.perspective;
  if (patch.perspective !== undefined) {
    if (patch.perspective === null) perspective = null;
    else if (isValidPerspectiveQuad(patch.perspective)) perspective = cloneQuad(patch.perspective);
  }
  return {
    position: pickVec(patch.position, prior.position),
    scale: pickVec(patch.scale, prior.scale),
    rotation: pickNumber(patch.rotation, prior.rotation),
    flipH: pickBoolean(patch.flipH, prior.flipH),
    flipV: pickBoolean(patch.flipV, prior.flipV),
    skew: pickVec(patch.skew, prior.skew),
    perspective,
  };
}

function isValidCrop(crop: CropV1): boolean {
  return (
    Number.isFinite(crop.x) &&
    Number.isFinite(crop.y) &&
    Number.isFinite(crop.width) &&
    Number.isFinite(crop.height) &&
    crop.width > 0 &&
    crop.height > 0
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function findLayerIndex(core: ProjectCoreV1, layerId: Id): number {
  return core.layers.findIndex((layer) => layer.id === layerId);
}

function withLayers(core: ProjectCoreV1, layers: LayerV1[]): ProjectCoreV1 {
  return { ...core, layers };
}

function updateLayer(
  core: ProjectCoreV1,
  layerId: Id,
  update: (layer: LayerV1) => LayerV1,
): ProjectCoreV1 {
  const index = findLayerIndex(core, layerId);
  if (index < 0) return core;
  const prior = core.layers[index];
  const next = update(prior);
  if (next === prior) return core;
  const layers = core.layers.slice();
  layers[index] = next;
  return withLayers(core, layers);
}

/** Merges a patch into a recipe group, dropping nonfinite numeric values. */
function mergeRecipeGroup<T extends object>(prior: T, patch: Partial<T>): T {
  const next = { ...prior };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    next[key] = value as T[keyof T];
  }
  return next;
}

function updateGuides(
  core: ProjectCoreV1,
  axis: GuideAxis,
  update: (offsets: number[]) => number[] | null,
): ProjectCoreV1 {
  const key = axis === "horizontal" ? "horizontal" : "vertical";
  const offsets = update(core.guides[key]);
  if (offsets === null) return core;
  const guides: GuidesV1 = { ...core.guides, [key]: offsets };
  return { ...core, guides };
}

export function applyCommand(core: ProjectCoreV1, command: Command): ProjectCoreV1 {
  switch (command.type) {
    case "layer/add": {
      if (core.layers.length >= RESOURCE_POLICY.maxLayers) return core;
      if (findLayerIndex(core, command.layer.id) >= 0) return core;
      const layers = core.layers.slice();
      const index =
        command.index === undefined
          ? layers.length
          : Math.min(Math.max(0, command.index), layers.length);
      layers.splice(index, 0, command.layer);
      return withLayers(core, layers);
    }

    case "layer/remove": {
      const index = findLayerIndex(core, command.layerId);
      if (index < 0) return core;
      const layers = core.layers.slice();
      layers.splice(index, 1);
      return withLayers(core, layers);
    }

    case "layer/duplicate": {
      if (core.layers.length >= RESOURCE_POLICY.maxLayers) return core;
      if (findLayerIndex(core, command.newLayerId) >= 0) return core;
      const index = findLayerIndex(core, command.layerId);
      if (index < 0) return core;
      const source = core.layers[index];
      const copy: LayerV1 = structuredClone(source);
      copy.id = command.newLayerId;
      copy.name = command.name ?? `${source.name} copy`;
      const layers = core.layers.slice();
      layers.splice(index + 1, 0, copy);
      return withLayers(core, layers);
    }

    case "layer/reorder": {
      const index = findLayerIndex(core, command.layerId);
      if (index < 0) return core;
      const toIndex = Math.min(Math.max(0, command.toIndex), core.layers.length - 1);
      if (toIndex === index) return core;
      const layers = core.layers.slice();
      const [layer] = layers.splice(index, 1);
      layers.splice(toIndex, 0, layer);
      return withLayers(core, layers);
    }

    case "layer/rename":
      return updateLayer(core, command.layerId, (layer) =>
        layer.name === command.name ? layer : { ...layer, name: command.name },
      );

    case "layer/set-visibility":
      return updateLayer(core, command.layerId, (layer) =>
        layer.visible === command.visible ? layer : { ...layer, visible: command.visible },
      );

    case "layer/set-locked":
      return updateLayer(core, command.layerId, (layer) =>
        layer.locked === command.locked ? layer : { ...layer, locked: command.locked },
      );

    case "layer/set-opacity": {
      if (!Number.isFinite(command.opacity)) return core;
      const opacity = clamp01(command.opacity);
      return updateLayer(core, command.layerId, (layer) =>
        layer.opacity === opacity ? layer : { ...layer, opacity },
      );
    }

    case "layer/set-crop": {
      if (command.crop !== null && !isValidCrop(command.crop)) return core;
      const crop = command.crop === null ? null : { ...command.crop };
      return updateLayer(core, command.layerId, (layer) => ({ ...layer, crop }));
    }

    case "layer/set-transform":
      return updateLayer(core, command.layerId, (layer) => ({
        ...layer,
        transform: sanitizeTransform(layer.transform, command.patch),
      }));

    case "layers/set-transforms": {
      let layers: LayerV1[] | null = null;
      for (const entry of command.entries) {
        const index = findLayerIndex(core, entry.layerId);
        if (index < 0) continue;
        const prior = (layers ?? core.layers)[index];
        if (prior.locked) continue;
        const next: LayerV1 = {
          ...prior,
          transform: sanitizeTransform(prior.transform, entry.transform),
        };
        if (layers === null) layers = core.layers.slice();
        layers[index] = next;
      }
      return layers === null ? core : withLayers(core, layers);
    }

    case "layer/set-mode":
      return updateLayer(core, command.layerId, (layer) =>
        layer.recipe.mode === command.mode
          ? layer
          : { ...layer, recipe: { ...layer.recipe, mode: command.mode } },
      );

    case "recipe/update-halftone":
      return updateLayer(core, command.layerId, (layer) => ({
        ...layer,
        recipe: {
          ...layer.recipe,
          halftone: mergeRecipeGroup(layer.recipe.halftone, command.patch),
        },
      }));

    case "recipe/update-diffusion":
      return updateLayer(core, command.layerId, (layer) => ({
        ...layer,
        recipe: {
          ...layer.recipe,
          diffusion: mergeRecipeGroup(layer.recipe.diffusion, command.patch),
        },
      }));

    case "recipe/update-glitch":
      return updateLayer(core, command.layerId, (layer) => ({
        ...layer,
        recipe: {
          ...layer.recipe,
          glitch: mergeRecipeGroup(layer.recipe.glitch, command.patch),
        },
      }));

    case "recipe/apply-preset":
      return updateLayer(core, command.layerId, (layer) => ({
        ...layer,
        recipe: structuredClone({
          mode: command.mode,
          halftone: command.halftone,
          diffusion: command.diffusion,
          glitch: command.glitch,
        }),
      }));

    case "artboard/resize": {
      const { widthPx, heightPx } = command;
      if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx)) return core;
      if (widthPx <= 0 || heightPx <= 0) return core;
      if (
        widthPx > RESOURCE_POLICY.maxArtboardEdge ||
        heightPx > RESOURCE_POLICY.maxArtboardEdge
      ) return core;
      if (widthPx * heightPx > RESOURCE_POLICY.maxArtboardPixels) return core;
      const artboard = { ...core.artboard, widthPx, heightPx, presetId: command.presetId };
      return { ...core, artboard };
    }

    case "artboard/set-background":
      if (core.artboard.background === command.background) return core;
      return { ...core, artboard: { ...core.artboard, background: command.background } };

    case "separation/set-mode":
      if (core.separation.mode === command.mode) return core;
      return { ...core, separation: { ...core.separation, mode: command.mode } };

    case "separation/set-angle": {
      if (!Number.isFinite(command.angle)) return core;
      if (core.separation.angles[command.plate] === command.angle) return core;
      return {
        ...core,
        separation: {
          ...core.separation,
          angles: { ...core.separation.angles, [command.plate]: command.angle },
        },
      };
    }

    case "separation/set-plate-visibility": {
      if (core.separation.visible[command.plate] === command.visible) return core;
      return {
        ...core,
        separation: {
          ...core.separation,
          visible: { ...core.separation.visible, [command.plate]: command.visible },
        },
      };
    }

    case "registration/update": {
      const patch = command.patch;
      const next = { ...core.registration };
      if (patch.size !== undefined) {
        if (patch.size === null || Number.isFinite(patch.size)) next.size = patch.size;
      }
      if (patch.offset !== undefined) {
        if (patch.offset === null || Number.isFinite(patch.offset)) next.offset = patch.offset;
      }
      if (patch.weight !== undefined && Number.isFinite(patch.weight)) next.weight = patch.weight;
      if (patch.mode !== undefined) next.mode = patch.mode;
      if (patch.customShapeAssetId !== undefined) next.customShapeAssetId = patch.customShapeAssetId;
      return { ...core, registration: next };
    }

    case "guides/add": {
      if (core.guides.locked || !Number.isFinite(command.offset)) return core;
      return updateGuides(core, command.axis, (offsets) => [...offsets, command.offset]);
    }

    case "guides/move": {
      if (core.guides.locked || !Number.isFinite(command.offset)) return core;
      return updateGuides(core, command.axis, (offsets) => {
        if (command.index < 0 || command.index >= offsets.length) return null;
        if (offsets[command.index] === command.offset) return null;
        const next = offsets.slice();
        next[command.index] = command.offset;
        return next;
      });
    }

    case "guides/remove": {
      if (core.guides.locked) return core;
      return updateGuides(core, command.axis, (offsets) => {
        if (command.index < 0 || command.index >= offsets.length) return null;
        const next = offsets.slice();
        next.splice(command.index, 1);
        return next;
      });
    }

    case "guides/set-locked":
      if (core.guides.locked === command.locked) return core;
      return { ...core, guides: { ...core.guides, locked: command.locked } };

    case "guides/set-visible":
      if (core.guides.visible === command.visible) return core;
      return { ...core, guides: { ...core.guides, visible: command.visible } };

    case "guides/clear": {
      if (core.guides.locked) return core;
      if (core.guides.horizontal.length === 0 && core.guides.vertical.length === 0) return core;
      return { ...core, guides: { ...core.guides, horizontal: [], vertical: [] } };
    }

    case "grid/update": {
      const next = { ...core.grid };
      if (command.patch.visible !== undefined) next.visible = command.patch.visible;
      if (
        command.patch.size !== undefined &&
        Number.isFinite(command.patch.size) &&
        command.patch.size > 0
      ) {
        next.size = command.patch.size;
      }
      return { ...core, grid: next };
    }

    case "snapping/update":
      return { ...core, snapping: { ...core.snapping, ...command.patch } };

    case "output/update":
      return { ...core, output: { ...core.output, ...command.patch } };

    case "unit/set":
      if (core.unitPreference === command.unitPreference) return core;
      return { ...core, unitPreference: command.unitPreference };

    case "snapshot/restore":
      return command.core;

    default: {
      const exhausted: never = command;
      void exhausted;
      return core;
    }
  }
}
