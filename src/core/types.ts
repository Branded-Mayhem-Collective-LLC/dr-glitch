/**
 * DR.GLITCH workstation core contract — versioned document, layer, and
 * persistence types shared by every subsystem. This file is the single
 * source of truth for shapes that cross module boundaries. Subsystems own
 * their internal types; anything that crosses a boundary lives here.
 *
 * Persistence rule: every exported *V1 type is a released schema. Fields may
 * be added only with optional semantics; breaking changes require a V2 plus
 * a forward migration. Workspace/session/history types never enter portable
 * files (.drglitch/.drpreset).
 */

/* ------------------------------------------------------------------ */
/* Identity and units                                                  */
/* ------------------------------------------------------------------ */

/** Opaque unique id (crypto.randomUUID). */
export type Id = string;

/** Lowercase hex SHA-256 digest addressing immutable asset bytes. */
export type Sha256 = string;

/**
 * Monotonic working revision of an open project. Increments on every
 * committed edit transaction (and on undo/redo). savedRevision is the
 * Revision captured by the last explicit Save; dirty === revision >
 * savedRevision. Recovery records, preflight warning confirmations, and
 * export jobs all bind to a Revision — use this alias, never a bare number,
 * so the semantics stay in one place.
 */
export type Revision = number;

/** Canonical raster resolution. All document geometry is integer px at this DPI. */
export const DOCUMENT_DPI = 240;

export type UnitPreference = "px" | "in" | "mm";

/* ------------------------------------------------------------------ */
/* Separation and plates (document-global)                             */
/* ------------------------------------------------------------------ */

export type PlateId = "cyan" | "magenta" | "yellow" | "black";

export const PLATE_IDS: PlateId[] = ["cyan", "magenta", "yellow", "black"];

export type SeparationMode = "cmyk" | "grayscale";

/** Document-global separation: screens anchor to artboard center with these angles. */
export type SeparationV1 = {
  mode: SeparationMode;
  /** Screen angles in degrees, document-global, anchored at artboard center. */
  angles: Record<PlateId, number>;
  /** Global plate visibility (Plates panel). */
  visible: Record<PlateId, boolean>;
};

/* ------------------------------------------------------------------ */
/* Layer recipe                                                        */
/* ------------------------------------------------------------------ */

export type LayerMode = "clean" | "halftone" | "diffusion";

export type DotShape =
  | "round"
  | "square"
  | "diamond"
  | "line"
  | "triangle"
  | "cross"
  | "circle-outline"
  | "custom";

export type HalftoneRecipeV1 = {
  /** Cell size in document pixels. */
  cellSize: number;
  dotShape: DotShape;
  /** Sanitized canonical custom-dot SVG asset, required when dotShape === "custom". */
  customShapeAssetId: Sha256 | null;
  invert: boolean;
  strokeWidth: number;
  frayedXEdge: number;
  frayedYEdge: number;
};

export type DiffusionAlgorithm =
  | "none"
  | "floyd-steinberg"
  | "jarvis-judice-ninke"
  | "stucki"
  | "burkes"
  | "atkinson";

export type DiffusionModulation =
  | "none"
  | "column"
  | "row"
  | "dispersed"
  | "medium"
  | "heavy"
  | "circuit"
  | "tilt"
  | "grid";

export type DiffusionRecipeV1 = {
  algorithm: DiffusionAlgorithm;
  modulation: DiffusionModulation;
  modStrength: number;
  intensity: number;
  levels: number;
  sharpenStrength: number;
  sharpenRadius: number;
  denoise: number;
  brokenKernel: number;
  directionalBias: number;
  directionalBiasAngle: number;
  errorOverflow: number;
  reset: number;
  crossChannelBleed: number;
  invert: boolean;
};

export type GlitchRecipeV1 = {
  enabled: boolean;
  sliceShift: number;
  sliceSize: number;
  verticalSliceShift: number;
  verticalSliceSize: number;
  gridWarp: number;
  warpScale: number;
  smearDrag: number;
  smearLength: number;
  smearVertical: boolean;
  macroblockCorrupt: number;
  macroblockDropout: number;
  blockShift: number;
  blockShiftSize: number;
  channelDesync: number;
  bitmapSort: number;
  bitmapSortVertical: boolean;
};

/**
 * A layer retains all three setting groups regardless of mode; switching
 * mode is one undoable action that never discards inactive settings.
 */
export type LayerRecipeV1 = {
  mode: LayerMode;
  halftone: HalftoneRecipeV1;
  diffusion: DiffusionRecipeV1;
  glitch: GlitchRecipeV1;
};

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export type Vec2 = { x: number; y: number };

/** Non-destructive crop rectangle in source-asset pixel space. */
export type CropV1 = { x: number; y: number; width: number; height: number };

/**
 * Free convex four-corner perspective in document pixel space, ordered
 * top-left, top-right, bottom-right, bottom-left. null means no perspective.
 * Winding must stay consistent with that corner order in y-down space
 * (mirrored quads are invalid). Producers must reject nonfinite, singular,
 * self-intersecting, concave, and near-zero-area quads without destroying
 * the prior valid value.
 */
export type PerspectiveQuadV1 = [Vec2, Vec2, Vec2, Vec2] | null;

/** Decomposed layer transform applied in document pixel space. */
export type TransformV1 = {
  /** Translation of the layer anchor (layer center) in document px. */
  position: Vec2;
  scale: Vec2;
  /** Rotation in degrees. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** Skew in degrees per axis. */
  skew: Vec2;
  perspective: PerspectiveQuadV1;
};

/* ------------------------------------------------------------------ */
/* Layers and artboard                                                 */
/* ------------------------------------------------------------------ */

export type LayerV1 = {
  id: Id;
  name: string;
  /** Content-addressed source asset (raster bytes or canonical SVG bytes). */
  assetId: Sha256;
  visible: boolean;
  locked: boolean;
  /** Single normal opacity 0..1; multiplies source alpha exactly once. */
  opacity: number;
  crop: CropV1 | null;
  transform: TransformV1;
  recipe: LayerRecipeV1;
};

export type ArtboardBackground = "white" | "black" | "transparent";

export type ArtboardV1 = {
  /** Integer document pixels at DOCUMENT_DPI. */
  widthPx: number;
  heightPx: number;
  /** Preset identity when the size matches a preset, else "custom". */
  presetId: string;
  /** Proof background / optional composite matte only; never plate ink. */
  background: ArtboardBackground;
};

/* ------------------------------------------------------------------ */
/* Guides, grid, snapping                                              */
/* ------------------------------------------------------------------ */

export type GuidesV1 = {
  /** Document-px offsets of horizontal guides (y positions). */
  horizontal: number[];
  /** Document-px offsets of vertical guides (x positions). */
  vertical: number[];
  locked: boolean;
  visible: boolean;
};

export type GridV1 = {
  visible: boolean;
  /** Grid spacing in document px. */
  size: number;
};

export type SnappingV1 = {
  enabled: boolean;
  toGuides: boolean;
  toGrid: boolean;
  toLayers: boolean;
  toArtboard: boolean;
};

/* ------------------------------------------------------------------ */
/* Registration and output defaults                                    */
/* ------------------------------------------------------------------ */

export type RegistrationMode = "corners" | "centered";

export type RegistrationV1 = {
  size: number | null;
  offset: number | null;
  weight: number;
  mode: RegistrationMode;
  customShapeAssetId: Sha256 | null;
};

export type OutputDefaultsV1 = {
  /**
   * Positive prints ink as dark; negative inverts at output. Polarity is the
   * ONLY output-stage inversion. Per-layer recipe inverts (halftone.invert,
   * diffusion.invert) act earlier, in coverage space before gamma, exactly as
   * the legacy engine's `invert` did. The two never merge: recipe inverts
   * shape coverage; polarity flips the final rendered plate at export.
   */
  polarity: "positive" | "negative";
  pressMirror: boolean;
  /** Registration on/off default per export family; overridable per export. */
  registrationOnPlates: boolean;
  registrationOnComposite: boolean;
};

/* ------------------------------------------------------------------ */
/* Project core, envelope, snapshots                                   */
/* ------------------------------------------------------------------ */

export type ProjectCoreV1 = {
  schema: 1;
  artboard: ArtboardV1;
  /** Bottom-to-top ordered stack; max ResourcePolicy.maxLayers. */
  layers: LayerV1[];
  separation: SeparationV1;
  registration: RegistrationV1;
  guides: GuidesV1;
  grid: GridV1;
  snapping: SnappingV1;
  output: OutputDefaultsV1;
  /** Display preference only; storage is always document px. */
  unitPreference: UnitPreference;
};

export type SnapshotV1 = {
  id: Id;
  name: string;
  createdAt: number;
  /** Thumbnail asset in the thumbnails store; may be null if capture failed. */
  thumbnailId: Sha256 | null;
  /** Nonrecursive: a snapshot core never embeds snapshots. */
  core: ProjectCoreV1;
};

export type ProjectEnvelopeV1 = {
  schema: 1;
  id: Id;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic revision of the last explicit Save; CAS token for writers. */
  savedRevision: number;
  core: ProjectCoreV1;
  snapshots: SnapshotV1[];
};

/* ------------------------------------------------------------------ */
/* Presets (device-global, portable)                                   */
/* ------------------------------------------------------------------ */

export type RecipePresetV1 = {
  schema: 1;
  id: Id;
  name: string;
  createdAt: number;
  mode: LayerMode;
  halftone: HalftoneRecipeV1;
  diffusion: DiffusionRecipeV1;
  glitch: GlitchRecipeV1;
  /** Canonical sanitized custom-dot SVG source, inlined for portability. */
  customDotSvg: string | null;
};

/* ------------------------------------------------------------------ */
/* Storage records (never portable)                                    */
/* Additional never-portable storage row types (leases, staging rows)  */
/* live in src/storage/schema.ts — do not re-declare them elsewhere.   */
/* ------------------------------------------------------------------ */

export type AssetKind = "raster" | "svg" | "thumbnail";

export type AssetRecordV1 = {
  sha256: Sha256;
  kind: AssetKind;
  mime: string;
  byteLength: number;
  width: number;
  height: number;
  createdAt: number;
};

export type RecoveryRecordV1 = {
  projectId: Id;
  /** Working revision the journal captured (> savedRevision when dirty). */
  revision: number;
  savedRevision: number;
  updatedAt: number;
  title: string;
  core: ProjectCoreV1;
  snapshots: SnapshotV1[];
};

export type TrashRecordV1 = {
  projectId: Id;
  deletedAt: number;
  /** deletedAt + 30 days. */
  expiresAt: number;
  title: string;
};

/* ------------------------------------------------------------------ */
/* Workspace layout (local-only, never portable)                       */
/* ------------------------------------------------------------------ */

export type PanelRect = { x: number; y: number; width: number; height: number };

export type PanelPlacementV1 = {
  /** ToolId is declared later in this file; type-only forward references are fine. */
  toolId: ToolId;
  mode: "docked" | "floating";
  /** Float rectangle in workspace px; retained while docked for restore. */
  rect: PanelRect | null;
  /** Raise order among floats; higher is frontmost. */
  z: number;
  open: boolean;
};

export type WorkspaceLayoutStateV1 = {
  schema: 1;
  dockWidth: number;
  /** Tool whose panel occupies the right dock, if any. */
  dockPanelId: ToolId | null;
  placements: PanelPlacementV1[];
  /** Which fixed drawer is expanded, at most one. */
  expandedDrawer: "document" | "proof" | "output" | null;
  locked: boolean;
};

/* ------------------------------------------------------------------ */
/* Session-only state (never persisted beyond the session)             */
/* ------------------------------------------------------------------ */

export type StudioSessionState = {
  activeToolId: ToolId;
  focusedPanelId: ToolId | null;
  /** Layer selection; primary is the last-selected id. */
  selectedLayerIds: Id[];
  primaryLayerId: Id | null;
  proofPlate: "composite" | PlateId;
  zoom: number;
  pan: Vec2;
  focusMode: boolean;
};

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

export type PreflightSeverity = "block" | "warn";

export type PreflightIssue = {
  id: string;
  severity: PreflightSeverity;
  /** Stable machine code, e.g. "asset-missing", "quad-invalid". */
  code: string;
  message: string;
  /** Layer or asset the issue points at, when applicable. */
  subject?: { layerId?: Id; assetId?: Sha256 };
  /** Core revision the issue was computed against (warnings bind confirmation to it). */
  revision: number;
};

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export type ToolId =
  | "select"
  | "layers"
  | "halftone"
  | "diffusion"
  | "glitch"
  | "plates"
  | "history"
  | "export";

export type ToolGroup = "tools" | "system";

export type ToolDefinition = {
  id: ToolId;
  label: string;
  /** Key into the replaceable icon map (icons.tsx). */
  iconKey: string;
  /** Registered single-key shortcut, suppressed while typing. */
  shortcut: string | null;
  group: ToolGroup;
  /** Panel component key resolved by the workspace panel registry. */
  panelKey: string;
  /** False when the tool is unavailable in the current context. */
  isEnabled?: (context: ToolCapabilityContext) => boolean;
};

export type ToolCapabilityContext = {
  hasProject: boolean;
  layerCount: number;
  selectionCount: number;
};
