/**
 * Hand-rolled structural validation for portable schemas (ProjectEnvelopeV1,
 * ProjectCoreV1, recipes). Untrusted JSON is never passed through: every
 * validator RECONSTRUCTS a fresh object containing exactly the schema fields,
 * so unknown properties, prototype pollution payloads, and wrong shapes can
 * never reach application state.
 *
 * Violations throw SchemaViolation with the offending path; format wrappers
 * (.drglitch / .drpreset) translate them into their own typed errors.
 */
import { RESOURCE_POLICY, type ResourcePolicy } from "../core/resource-policy";
import {
  PLATE_IDS,
  type ArtboardV1,
  type CropV1,
  type DiffusionRecipeV1,
  type GlitchRecipeV1,
  type GridV1,
  type GuidesV1,
  type HalftoneRecipeV1,
  type LayerRecipeV1,
  type LayerV1,
  type OutputDefaultsV1,
  type PerspectiveQuadV1,
  type ProjectCoreV1,
  type ProjectEnvelopeV1,
  type RegistrationV1,
  type SeparationV1,
  type Sha256,
  type SnappingV1,
  type SnapshotV1,
  type TransformV1,
  type Vec2,
} from "../core/types";
import { isSha256Hex } from "./sha256";

export class SchemaViolation extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "SchemaViolation";
    this.path = path;
  }
}

function fail(path: string, reason: string): never {
  throw new SchemaViolation(path, reason);
}

/** Generic magnitude cap for recipe/geometry numerics; nothing legitimate exceeds it. */
const MAX_VALUE = 1_000_000;
const MAX_NAME = 255;
const MAX_TITLE = 500;
const MAX_GUIDES = 1_000;

function record(path: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function bool(path: string, value: unknown): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function text(path: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") fail(path, "expected a string");
  if (value.length > maxLength) fail(path, `longer than ${maxLength} characters`);
  return value;
}

type NumberRule = { min?: number; max?: number; integer?: boolean };

function num(path: string, value: unknown, rule: NumberRule = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
  if (rule.integer && !Number.isSafeInteger(value)) fail(path, "expected an integer");
  const min = rule.min ?? -MAX_VALUE;
  const max = rule.max ?? MAX_VALUE;
  if (value < min || value > max) fail(path, `outside ${min}..${max}`);
  return value;
}

function oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function sha(path: string, value: unknown): Sha256 {
  if (!isSha256Hex(value)) fail(path, "expected a lowercase hex sha-256");
  return value;
}

function shaOrNull(path: string, value: unknown): Sha256 | null {
  return value === null ? null : sha(path, value);
}

function id(path: string, value: unknown): string {
  const v = text(path, value, 128);
  if (!v) fail(path, "expected a non-empty id");
  return v;
}

function vec2(path: string, value: unknown): Vec2 {
  const raw = record(path, value);
  return { x: num(`${path}.x`, raw.x), y: num(`${path}.y`, raw.y) };
}

/* ------------------------------------------------------------------ */
/* Recipes                                                             */
/* ------------------------------------------------------------------ */

const LAYER_MODES = ["clean", "halftone", "diffusion"] as const;
const DOT_SHAPES = ["round", "square", "diamond", "line", "triangle", "cross", "circle-outline", "custom"] as const;
const DIFFUSION_ALGORITHMS = ["none", "floyd-steinberg", "jarvis-judice-ninke", "stucki", "burkes", "atkinson"] as const;
const DIFFUSION_MODULATIONS = ["none", "column", "row", "dispersed", "medium", "heavy", "circuit", "tilt", "grid"] as const;

export function validateHalftoneRecipe(path: string, value: unknown): HalftoneRecipeV1 {
  const raw = record(path, value);
  return {
    cellSize: num(`${path}.cellSize`, raw.cellSize, { min: 0.5, max: 256 }),
    dotShape: oneOf(`${path}.dotShape`, raw.dotShape, DOT_SHAPES),
    customShapeAssetId: shaOrNull(`${path}.customShapeAssetId`, raw.customShapeAssetId ?? null),
    invert: bool(`${path}.invert`, raw.invert),
    strokeWidth: num(`${path}.strokeWidth`, raw.strokeWidth, { min: 0, max: 100 }),
    frayedXEdge: num(`${path}.frayedXEdge`, raw.frayedXEdge, { min: 0, max: 100 }),
    frayedYEdge: num(`${path}.frayedYEdge`, raw.frayedYEdge, { min: 0, max: 100 }),
  };
}

export function validateDiffusionRecipe(path: string, value: unknown): DiffusionRecipeV1 {
  const raw = record(path, value);
  const field = (name: string, rule: NumberRule = {}) => num(`${path}.${name}`, raw[name], rule);
  return {
    algorithm: oneOf(`${path}.algorithm`, raw.algorithm, DIFFUSION_ALGORITHMS),
    modulation: oneOf(`${path}.modulation`, raw.modulation, DIFFUSION_MODULATIONS),
    modStrength: field("modStrength"),
    intensity: field("intensity"),
    levels: field("levels", { min: 1, max: 256 }),
    sharpenStrength: field("sharpenStrength"),
    sharpenRadius: field("sharpenRadius", { min: 0, max: 1024 }),
    denoise: field("denoise"),
    brokenKernel: field("brokenKernel"),
    directionalBias: field("directionalBias"),
    directionalBiasAngle: field("directionalBiasAngle"),
    errorOverflow: field("errorOverflow"),
    reset: field("reset"),
    crossChannelBleed: field("crossChannelBleed"),
    invert: bool(`${path}.invert`, raw.invert),
  };
}

export function validateGlitchRecipe(path: string, value: unknown): GlitchRecipeV1 {
  const raw = record(path, value);
  const field = (name: string) => num(`${path}.${name}`, raw[name]);
  return {
    enabled: bool(`${path}.enabled`, raw.enabled),
    sliceShift: field("sliceShift"),
    sliceSize: field("sliceSize"),
    verticalSliceShift: field("verticalSliceShift"),
    verticalSliceSize: field("verticalSliceSize"),
    gridWarp: field("gridWarp"),
    warpScale: field("warpScale"),
    smearDrag: field("smearDrag"),
    smearLength: field("smearLength"),
    smearVertical: bool(`${path}.smearVertical`, raw.smearVertical),
    macroblockCorrupt: field("macroblockCorrupt"),
    macroblockDropout: field("macroblockDropout"),
    blockShift: field("blockShift"),
    blockShiftSize: field("blockShiftSize"),
    channelDesync: field("channelDesync"),
    bitmapSort: field("bitmapSort"),
    bitmapSortVertical: bool(`${path}.bitmapSortVertical`, raw.bitmapSortVertical),
  };
}

export function validateLayerMode(path: string, value: unknown): (typeof LAYER_MODES)[number] {
  return oneOf(path, value, LAYER_MODES);
}

export function validateLayerRecipe(path: string, value: unknown): LayerRecipeV1 {
  const raw = record(path, value);
  return {
    mode: validateLayerMode(`${path}.mode`, raw.mode),
    halftone: validateHalftoneRecipe(`${path}.halftone`, raw.halftone),
    diffusion: validateDiffusionRecipe(`${path}.diffusion`, raw.diffusion),
    glitch: validateGlitchRecipe(`${path}.glitch`, raw.glitch),
  };
}

/* ------------------------------------------------------------------ */
/* Geometry, layers, document                                          */
/* ------------------------------------------------------------------ */

function validateCrop(path: string, value: unknown): CropV1 | null {
  if (value === null || value === undefined) return null;
  const raw = record(path, value);
  return {
    x: num(`${path}.x`, raw.x, { min: 0 }),
    y: num(`${path}.y`, raw.y, { min: 0 }),
    width: num(`${path}.width`, raw.width, { min: 1 }),
    height: num(`${path}.height`, raw.height, { min: 1 }),
  };
}

function validatePerspective(path: string, value: unknown): PerspectiveQuadV1 {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length !== 4) fail(path, "expected four corner points or null");
  return [
    vec2(`${path}[0]`, value[0]),
    vec2(`${path}[1]`, value[1]),
    vec2(`${path}[2]`, value[2]),
    vec2(`${path}[3]`, value[3]),
  ];
}

function validateTransform(path: string, value: unknown): TransformV1 {
  const raw = record(path, value);
  const scale = vec2(`${path}.scale`, raw.scale);
  if (scale.x === 0 || scale.y === 0) fail(`${path}.scale`, "scale must be nonzero");
  return {
    position: vec2(`${path}.position`, raw.position),
    scale,
    rotation: num(`${path}.rotation`, raw.rotation),
    flipH: bool(`${path}.flipH`, raw.flipH),
    flipV: bool(`${path}.flipV`, raw.flipV),
    skew: vec2(`${path}.skew`, raw.skew),
    perspective: validatePerspective(`${path}.perspective`, raw.perspective),
  };
}

function validateLayer(path: string, value: unknown): LayerV1 {
  const raw = record(path, value);
  return {
    id: id(`${path}.id`, raw.id),
    name: text(`${path}.name`, raw.name, MAX_NAME),
    assetId: sha(`${path}.assetId`, raw.assetId),
    visible: bool(`${path}.visible`, raw.visible),
    locked: bool(`${path}.locked`, raw.locked),
    opacity: num(`${path}.opacity`, raw.opacity, { min: 0, max: 1 }),
    crop: validateCrop(`${path}.crop`, raw.crop),
    transform: validateTransform(`${path}.transform`, raw.transform),
    recipe: validateLayerRecipe(`${path}.recipe`, raw.recipe),
  };
}

function validateArtboard(path: string, value: unknown, policy: ResourcePolicy): ArtboardV1 {
  const raw = record(path, value);
  const widthPx = num(`${path}.widthPx`, raw.widthPx, { min: 1, max: MAX_VALUE, integer: true });
  const heightPx = num(`${path}.heightPx`, raw.heightPx, { min: 1, max: MAX_VALUE, integer: true });
  if (widthPx > policy.maxArtboardEdge || heightPx > policy.maxArtboardEdge) {
    fail(path, `artboard edge exceeds ${policy.maxArtboardEdge} pixels`);
  }
  if (widthPx * heightPx > policy.maxArtboardPixels) {
    fail(path, `artboard exceeds ${policy.maxArtboardPixels} pixels`);
  }
  return {
    widthPx,
    heightPx,
    presetId: text(`${path}.presetId`, raw.presetId, 128),
    background: oneOf(`${path}.background`, raw.background, ["white", "black", "transparent"] as const),
  };
}

function validateSeparation(path: string, value: unknown): SeparationV1 {
  const raw = record(path, value);
  const rawAngles = record(`${path}.angles`, raw.angles);
  const rawVisible = record(`${path}.visible`, raw.visible);
  const angles = {} as SeparationV1["angles"];
  const visible = {} as SeparationV1["visible"];
  for (const plate of PLATE_IDS) {
    angles[plate] = num(`${path}.angles.${plate}`, rawAngles[plate], { min: -3600, max: 3600 });
    visible[plate] = bool(`${path}.visible.${plate}`, rawVisible[plate]);
  }
  return {
    mode: oneOf(`${path}.mode`, raw.mode, ["cmyk", "grayscale"] as const),
    angles,
    visible,
  };
}

function validateRegistration(path: string, value: unknown): RegistrationV1 {
  const raw = record(path, value);
  return {
    size: raw.size === null || raw.size === undefined ? null : num(`${path}.size`, raw.size, { min: 0 }),
    offset: raw.offset === null || raw.offset === undefined ? null : num(`${path}.offset`, raw.offset, { min: 0 }),
    weight: num(`${path}.weight`, raw.weight, { min: 0, max: 1024 }),
    mode: oneOf(`${path}.mode`, raw.mode, ["corners", "centered"] as const),
    customShapeAssetId: shaOrNull(`${path}.customShapeAssetId`, raw.customShapeAssetId ?? null),
  };
}

function guideList(path: string, value: unknown): number[] {
  if (!Array.isArray(value)) fail(path, "expected an array of numbers");
  if (value.length > MAX_GUIDES) fail(path, `more than ${MAX_GUIDES} guides`);
  return value.map((entry, index) => num(`${path}[${index}]`, entry));
}

function validateGuides(path: string, value: unknown): GuidesV1 {
  const raw = record(path, value);
  return {
    horizontal: guideList(`${path}.horizontal`, raw.horizontal),
    vertical: guideList(`${path}.vertical`, raw.vertical),
    locked: bool(`${path}.locked`, raw.locked),
    visible: bool(`${path}.visible`, raw.visible),
  };
}

function validateGrid(path: string, value: unknown): GridV1 {
  const raw = record(path, value);
  return {
    visible: bool(`${path}.visible`, raw.visible),
    size: num(`${path}.size`, raw.size, { min: 1, max: 100_000 }),
  };
}

function validateSnapping(path: string, value: unknown): SnappingV1 {
  const raw = record(path, value);
  return {
    enabled: bool(`${path}.enabled`, raw.enabled),
    toGuides: bool(`${path}.toGuides`, raw.toGuides),
    toGrid: bool(`${path}.toGrid`, raw.toGrid),
    toLayers: bool(`${path}.toLayers`, raw.toLayers),
    toArtboard: bool(`${path}.toArtboard`, raw.toArtboard),
  };
}

function validateOutput(path: string, value: unknown): OutputDefaultsV1 {
  const raw = record(path, value);
  return {
    polarity: oneOf(`${path}.polarity`, raw.polarity, ["positive", "negative"] as const),
    pressMirror: bool(`${path}.pressMirror`, raw.pressMirror),
    registrationOnPlates: bool(`${path}.registrationOnPlates`, raw.registrationOnPlates),
    registrationOnComposite: bool(`${path}.registrationOnComposite`, raw.registrationOnComposite),
  };
}

export function validateProjectCore(path: string, value: unknown, policy: ResourcePolicy = RESOURCE_POLICY): ProjectCoreV1 {
  const raw = record(path, value);
  if (raw.schema !== 1) fail(`${path}.schema`, "expected schema 1");
  if (!Array.isArray(raw.layers)) fail(`${path}.layers`, "expected an array");
  if (raw.layers.length > policy.maxLayers) fail(`${path}.layers`, `more than ${policy.maxLayers} layers`);
  const layerIds = new Set<string>();
  const layers = raw.layers.map((layer, index) => {
    const valid = validateLayer(`${path}.layers[${index}]`, layer);
    if (layerIds.has(valid.id)) fail(`${path}.layers[${index}].id`, "duplicate layer id");
    layerIds.add(valid.id);
    return valid;
  });
  return {
    schema: 1,
    artboard: validateArtboard(`${path}.artboard`, raw.artboard, policy),
    layers,
    separation: validateSeparation(`${path}.separation`, raw.separation),
    registration: validateRegistration(`${path}.registration`, raw.registration),
    guides: validateGuides(`${path}.guides`, raw.guides),
    grid: validateGrid(`${path}.grid`, raw.grid),
    snapping: validateSnapping(`${path}.snapping`, raw.snapping),
    output: validateOutput(`${path}.output`, raw.output),
    unitPreference: oneOf(`${path}.unitPreference`, raw.unitPreference, ["px", "in", "mm"] as const),
  };
}

function validateSnapshot(path: string, value: unknown, policy: ResourcePolicy): SnapshotV1 {
  const raw = record(path, value);
  return {
    id: id(`${path}.id`, raw.id),
    name: text(`${path}.name`, raw.name, MAX_NAME),
    createdAt: num(`${path}.createdAt`, raw.createdAt, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    thumbnailId: shaOrNull(`${path}.thumbnailId`, raw.thumbnailId ?? null),
    core: validateProjectCore(`${path}.core`, raw.core, policy),
  };
}

export function validateProjectEnvelope(value: unknown, policy: ResourcePolicy = RESOURCE_POLICY): ProjectEnvelopeV1 {
  const raw = record("project", value);
  if (raw.schema !== 1) fail("project.schema", "expected schema 1");
  if (!Array.isArray(raw.snapshots)) fail("project.snapshots", "expected an array");
  if (raw.snapshots.length > policy.maxSnapshots) fail("project.snapshots", `more than ${policy.maxSnapshots} snapshots`);
  const snapshotIds = new Set<string>();
  const snapshots = raw.snapshots.map((snapshot, index) => {
    const valid = validateSnapshot(`project.snapshots[${index}]`, snapshot, policy);
    if (snapshotIds.has(valid.id)) fail(`project.snapshots[${index}].id`, "duplicate snapshot id");
    snapshotIds.add(valid.id);
    return valid;
  });
  return {
    schema: 1,
    id: id("project.id", raw.id),
    title: text("project.title", raw.title, MAX_TITLE),
    createdAt: num("project.createdAt", raw.createdAt, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    updatedAt: num("project.updatedAt", raw.updatedAt, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    savedRevision: num("project.savedRevision", raw.savedRevision, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
    core: validateProjectCore("project.core", raw.core, policy),
    snapshots,
  };
}
