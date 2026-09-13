/**
 * DR.GLITCH render module — DOM-free kernels with proven parity to the
 * studio engine, plate composition with knockout, tiling/banding, and the
 * worker execution architecture.
 *
 * Worker entry points (preview.worker.ts / export.worker.ts) are not
 * re-exported here; construct them with
 * `new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" })`.
 */
export {
  clamp,
  createRaster,
  extractAlphaField,
  flattenOntoWhite,
  premultiply,
  sampleFieldNearest,
  samplePremultipliedBilinear,
  unpremultiply,
  type RasterData,
} from "./raster";

export {
  activePlates,
  plateChannelIndex,
  PLATE_PROOF_COLORS,
  PLATE_SEQUENCE,
  type DiffusionAlgorithmSetting,
  type DiffusionModulationSetting,
  type RenderPlateId,
  type RenderSettings,
} from "./settings";

export {
  applyFrayedEdges,
  buildCleanField,
  buildCleanFieldCoop,
  buildCoverageBase,
  buildCoverageBaseCoop,
  buildCoverageField,
  buildCoverageFieldCoop,
  coverageFor,
  rgbToCmyk,
  visibleContentBounds,
  type ContentBounds,
} from "./kernels/coverage";

export {
  bitmapSortField,
  bitmapSortFieldCoop,
  buildGlitchField,
  buildGlitchFieldCoop,
  glitchActive,
  glitchSamplePoint,
  type GlitchSample,
} from "./kernels/glitch";

export {
  boxBlurField,
  boxBlurFieldCoop,
  buildDiffusionField,
  buildDiffusionFieldCoop,
  deterministicNoise,
  DIFFUSION_KERNELS,
  DIFFUSION_MAX_ROW_REACH,
  diffuseField,
  diffusionOffset,
  preprocessDiffusionField,
  preprocessDiffusionFieldCoop,
  processBandedDiffusion,
  processBandedDiffusionCoop,
} from "./kernels/diffusion";

export {
  collectGridDots,
  collectGridDotsCoop,
  effectiveCellSize,
  estimateGridCandidates,
  estimateGridPoints,
  iterateGridDots,
  MAX_GRID_CANDIDATES,
  MAX_RASTER_GRID_POINTS,
  MIN_DOT_SIZE,
  type DotPlacement,
  type GridGeometry,
  type TrackedDotPlacements,
  type TileRect,
} from "./kernels/halftone-grid";

export {
  JS_PLACEMENT_BYTES_PER_DOT,
  PACKED_PLACEMENT_BYTES_PER_DOT,
} from "./placement-memory";

export {
  allocField,
  chunkRowsFor,
  copyField,
  getAllocationObserver,
  MemoryLedger,
  noteAlloc,
  noteRasterAlloc,
  noteRasterRelease,
  noteRelease,
  retainAllocation,
  releaseField,
  setAllocationObserver,
  yieldToEventLoop,
  type AllocationKind,
  type AllocationObserver,
  type Checkpoint,
} from "./instrumentation";

export { cropRaster, downsampleRasterToEdge, resolvePrepRaster, warpRasterBanded } from "./prep";

export {
  DRAFT_CACHE_MAX_BYTES,
  DraftFieldCache,
  splatterPlacements,
  splatterSupports,
  type DraftFields,
} from "./draft";

export {
  accumulateLayerBand,
  composePlate,
  createProofAccumulator,
  foldPlateIntoProof,
  foldPlateRowsIntoProof,
  opaqueAlphaField,
  plateInkCoverage,
  proofCompositeCmyk,
  quantizeProofRows,
  releaseProofAccumulator,
  type ComposedPlate,
  type PlateLayerOutput,
  type ProofAccumulator,
} from "./compose";

export {
  discardPayload,
  exportLayerTransferables,
  jobTransferables,
  layerTransferables,
  payloadTransferables,
  type ComposedPlateData,
  type FieldTransfer,
  type LayerPlateData,
  type LayerPrepTransfer,
  type RasterTransfer,
  type RenderCancelledEvent,
  type RenderCancelRequest,
  type RenderDisposedEvent,
  type RenderDisposeRequest,
  type RenderErrorEvent,
  type RenderExportBandAckRequest,
  type RenderExportBeginRequest,
  type RenderExportFinalizeRequest,
  type RenderExportLayerAckEvent,
  type RenderExportLayerRequest,
  type RenderExportPlateBandEvent,
  type RenderExportPlateCompleteEvent,
  type RenderExportProofBandEvent,
  type RenderExportReadyEvent,
  type RenderJobKind,
  type RenderJobRequest,
  type RenderLayerInput,
  type RenderPort,
  type RenderProgressEvent,
  type RenderProgressPhase,
  type RenderResultEvent,
  type RenderResultPayload,
  type RenderWorkerEvent,
  type RenderWorkerRequest,
  type Revision,
  type StreamingRenderPort,
} from "./protocol";

export {
  executeRenderJob,
  jobTiles,
  layerPlateVisible,
  paintDot,
  rasterizePlacements,
  rasterizePlacementsTiled,
  RenderJobError,
  resolveLayerInputRaster,
  supportsCreateImageBitmap,
  supportsOffscreenCanvas,
  type ExecutorHooks,
} from "./executor";

export { StreamingExportSession, type StreamingSessionHooks } from "./streaming";

export { MainThreadRenderer } from "./main-thread-renderer";

export {
  BYTES_PER_FIELD_PIXEL,
  BYTES_PER_RGBA_PIXEL,
  chooseBandHeight,
  chooseComposeBandHeight,
  chunkTiles,
  COLLECTOR_FIELDS,
  DEFAULT_BAND_BYTES,
  DEFAULT_ENCODE_BYTES_PER_PIXEL,
  DEFAULT_TILE_EDGE,
  adaptiveDraftEdge,
  DRAFT_MAX_SAMPLE_EDGE,
  draftScaleFor,
  MIN_DRAFT_EDGE,
  estimateAppConcurrentBytes,
  estimateAppFinalizeBytes,
  estimateFieldBytes,
  estimateRenderPeakBytes,
  estimateSingleShotPeakBytes,
  estimateStreamedPeakBytes,
  isStreamable,
  kernelTransientFields,
  PEAK_FIELDS_PER_PLATE,
  PLACEMENT_BYTES_PER_DOT,
  planRender,
  previewDraftIsApproximate,
  PROOF_ACCUMULATOR_FIELDS,
  RETAINED_FIELDS_PER_PLATE,
  STREAM_BAND_BUFFERS,
  STREAM_DELIVERY_BAND_WINDOW,
  STREAM_ENCODE_FIXED_BYTES,
  estimateStreamedSinkBytes,
  TILE_CANVAS_BYTES,
  type PlanLayerModel,
  type PlanOutputModel,
  type RenderJobForm,
  type RenderPlan,
  type RenderPlanInput,
} from "./planner";
