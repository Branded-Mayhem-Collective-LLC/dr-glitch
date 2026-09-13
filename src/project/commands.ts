/**
 * Discriminated-union command model for every undoable document edit.
 * Commands are plain data: the reducer (reducer.ts) is the only interpreter.
 * Session state (selection, zoom, panels, proof plate) never appears here —
 * only ProjectCoreV1 mutations are commands.
 */
import type {
  ArtboardBackground,
  CropV1,
  DiffusionRecipeV1,
  GlitchRecipeV1,
  GridV1,
  HalftoneRecipeV1,
  Id,
  LayerMode,
  LayerV1,
  OutputDefaultsV1,
  PlateId,
  ProjectCoreV1,
  RegistrationV1,
  SeparationMode,
  SnappingV1,
  TransformV1,
  UnitPreference,
} from "../core/types";

export type GuideAxis = "horizontal" | "vertical";

/** Partial transform update; omitted fields keep their prior values. */
export type TransformPatch = Partial<TransformV1>;

export type Command =
  /* Layers */
  | { type: "layer/add"; layer: LayerV1; index?: number }
  | { type: "layer/remove"; layerId: Id }
  | { type: "layer/duplicate"; layerId: Id; newLayerId: Id; name?: string }
  | { type: "layer/reorder"; layerId: Id; toIndex: number }
  | { type: "layer/rename"; layerId: Id; name: string }
  | { type: "layer/set-visibility"; layerId: Id; visible: boolean }
  | { type: "layer/set-locked"; layerId: Id; locked: boolean }
  | { type: "layer/set-opacity"; layerId: Id; opacity: number }
  | { type: "layer/set-crop"; layerId: Id; crop: CropV1 | null }
  | { type: "layer/set-transform"; layerId: Id; patch: TransformPatch }
  /**
   * Group transform: absolute per-layer transforms computed by the
   * interaction layer, applied atomically as one undoable action.
   * Locked layers are skipped by the reducer.
   */
  | {
      type: "layers/set-transforms";
      entries: { layerId: Id; transform: TransformV1 }[];
    }
  /* Recipes. Mode switch preserves inactive setting groups. */
  | { type: "layer/set-mode"; layerId: Id; mode: LayerMode }
  | { type: "recipe/update-halftone"; layerId: Id; patch: Partial<HalftoneRecipeV1> }
  | { type: "recipe/update-diffusion"; layerId: Id; patch: Partial<DiffusionRecipeV1> }
  | { type: "recipe/update-glitch"; layerId: Id; patch: Partial<GlitchRecipeV1> }
  | {
      type: "recipe/apply-preset";
      layerId: Id;
      mode: LayerMode;
      halftone: HalftoneRecipeV1;
      diffusion: DiffusionRecipeV1;
      glitch: GlitchRecipeV1;
    }
  /* Artboard */
  | { type: "artboard/resize"; widthPx: number; heightPx: number; presetId: string }
  | { type: "artboard/set-background"; background: ArtboardBackground }
  /* Separation (document-global) */
  | { type: "separation/set-mode"; mode: SeparationMode }
  | { type: "separation/set-angle"; plate: PlateId; angle: number }
  | { type: "separation/set-plate-visibility"; plate: PlateId; visible: boolean }
  /* Registration */
  | { type: "registration/update"; patch: Partial<RegistrationV1> }
  /* Guides, grid, snapping */
  | { type: "guides/add"; axis: GuideAxis; offset: number }
  | { type: "guides/move"; axis: GuideAxis; index: number; offset: number }
  | { type: "guides/remove"; axis: GuideAxis; index: number }
  | { type: "guides/set-locked"; locked: boolean }
  | { type: "guides/set-visible"; visible: boolean }
  | { type: "guides/clear" }
  | { type: "grid/update"; patch: Partial<GridV1> }
  | { type: "snapping/update"; patch: Partial<SnappingV1> }
  /* Output defaults and units */
  | { type: "output/update"; patch: Partial<OutputDefaultsV1> }
  | { type: "unit/set"; unitPreference: UnitPreference }
  /* Snapshot restore: replaces the whole core as one undoable action. */
  | { type: "snapshot/restore"; core: ProjectCoreV1 };

export type CommandType = Command["type"];
