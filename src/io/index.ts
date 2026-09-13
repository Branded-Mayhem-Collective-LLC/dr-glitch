/**
 * Secure import/export boundary for DR.GLITCH. Every untrusted file (SVG,
 * raster, ZIP, .drglitch, .drpreset) must enter through this module; each
 * rejection is a typed error with a stable code.
 */
export { isSha256Hex, sha256Hex, sha256HexAbortable } from "./sha256";
export {
  sanitizeSvg,
  SvgValidationError,
  SVG_PROFILE_LIMITS,
  type SanitizedSvg,
  type SvgErrorCode,
  type SvgProfile,
  type SvgProfileLimits,
} from "./svg-sanitizer";
export {
  sniffRasterFormat,
  validateRaster,
  RasterValidationError,
  type RasterErrorCode,
  type RasterFormat,
  type RasterInfo,
  type RasterPolicy,
  type RasterValidationOptions,
} from "./raster-validator";
export {
  createBrowserRasterDecoder,
  defaultRasterDecoder,
  hasBrowserRasterDecoder,
  validateRasterPayload,
  type DecodedRasterDimensions,
  type DecodedRasterInfo,
  type RasterDecoder,
  type RasterPayloadValidationOptions,
} from "./raster-decoder";
export {
  ArchiveValidationError,
  ImportOperation,
  WorkingSetLedger,
  type ArchiveErrorCode,
  type ImportOperationOptions,
} from "./operation";
export {
  readArchive,
  openArchiveStream,
  validateEntryName,
  DEFAULT_MAX_WORKING_SET_BYTES,
  type ArchivePolicy,
  type ArchiveStream,
  type ArchiveStreamOptions,
  type ReadArchiveOptions,
} from "./zip-reader";
export {
  writeArchive,
  ARCHIVE_EPOCH,
  type ArchiveInputEntry,
  type WriteArchiveOptions,
} from "./zip-writer";
export {
  SchemaViolation,
  validateDiffusionRecipe,
  validateGlitchRecipe,
  validateHalftoneRecipe,
  validateLayerMode,
  validateLayerRecipe,
  validateProjectCore,
  validateProjectEnvelope,
} from "./validate";
export {
  collectAssetReferences,
  exportDrglitch,
  exportDrglitchToSink,
  planDrglitchExport,
  importDrglitch,
  DrglitchError,
  DRGLITCH_FORMAT,
  DRGLITCH_SCHEMA,
  DRGLITCH_MAX_MANIFEST_BYTES,
  DRGLITCH_MAX_PROJECT_BYTES,
  DEFAULT_IMPORT_TIMEOUT_MS,
  type DrglitchAssetExt,
  type DrglitchAssetSource,
  type DrglitchErrorCode,
  type DrglitchImportPhase,
  type DrglitchImportProgress,
  type DrglitchManifest,
  type DrglitchByteSink,
  type DrglitchExportPlan,
  type DrglitchExportPlanEntry,
  type ExportDrglitchOptions,
  type ImportDrglitchOptions,
  type StagingSink,
} from "./drglitch";
export {
  parsePreset,
  serializePreset,
  PresetValidationError,
  DRPRESET_SCHEMA,
  MAX_PRESET_TEXT_LENGTH,
  type ParsePresetOptions,
  type PresetErrorCode,
} from "./drpreset";
