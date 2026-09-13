/** Public surface of the export/preflight subsystem. */

export {
  contributingLayers,
  contributingPlates,
  describeTarget,
  exportBaseName,
  exportBounds,
  formatExtension,
  formatMime,
  formatSupportsAlpha,
  PLATE_SHORT,
  plateFileName,
  plateSettingsFileName,
  resolveMatte,
  resolveRegistration,
  svgPlateFolderName,
  targetFileName,
  targetIsTransparent,
  type CompositeFormat,
  type CompositeTarget,
  type ExportFormat,
  type ExportTarget,
  type PlatePackageFormat,
  type PlatePackageTarget,
  type SelectedLayerFormat,
  type SelectedLayerTarget,
} from "./targets";

export {
  BLOCK_CODES,
  CONVENTIONAL_ANGLES,
  evaluate,
  invalidQuadReason,
  invalidTransformReason,
  RENDER_PEAK_BYTES_PER_PIXEL,
  vectorPlateEligibility,
  WARN_CODES,
  type AssetInfo,
  type PreflightBlockCode,
  type PreflightCapabilities,
  type PreflightCode,
  type PreflightOptions,
  type PreflightWarnCode,
  type VectorEligibility,
} from "./preflight";

export {
  cropSourceRaster,
  layerOutputHomography,
  prepareLayerRaster,
  type LayerPrepOptions,
} from "./layer-prep";

export {
  invertPlateInk,
  mirrorRasterHorizontal,
  mirrorSvgHorizontal,
  PLATE_INK_RGB,
  polarityApplies,
  transformExportRaster,
  transformExportSvg,
} from "./output-transforms";

export {
  createWorkerRenderService,
  paintRegistrationMarks,
  renderSettingsFromLayer,
  type WorkerRenderServiceOptions,
  type WorkerRenderSources,
} from "./worker-render-service";

export {
  encodeTiff,
  encodeTiffGray,
  encodeTiffRgba,
  TIFF_DEFAULT_DPI,
  type TiffColorType,
  type TiffEncodeOptions,
} from "./tiff";

export {
  deliverExportFiles,
  ExportCancelledError,
  ExportError,
  startExport,
  supportsFileSystemAccess,
  totalExportBytes,
  type DeliveryOptions,
  type ExportEncoders,
  type ExportFile,
  type ExportJob,
  type ExportJobOptions,
  type ExportPhase,
  type ExportProgress,
  type RasterData,
  type RenderRequestOptions,
  type RenderService,
  type ZipEntry,
} from "./orchestrator";

export { BROWSER_EXPORT_ENCODERS, downloadExportBlob } from "./encoders";

export {
  buildPlateJobSettings,
  documentSettingsFromCore,
  manifestLayer,
  omittedPlates,
  type PlateJobSettingsOptions,
} from "./job-settings";

export {
  createCurrentEngineRenderService,
  createRoutedRenderService,
  halftoneSettingsFromCore,
  legacyEngineEligible,
  type AssetDimensionLookup,
  type CurrentEngineSources,
  type RoutedRenderServiceOptions,
} from "./current-engine";
