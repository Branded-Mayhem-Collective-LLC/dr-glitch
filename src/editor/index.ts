/**
 * Editor geometry/interaction math — React-free, pure, Float64.
 *
 * Consumers:
 * - render pipeline: composeTransform, solveRectToQuad, warpRaster, croppedSize
 * - workspace UI: snapping, rulers, alignment, guide hit-testing
 * - reducers/commands: applyGroupTransform, clampCrop, validateQuad
 */

export {
  type Mat3,
  mat3Identity,
  mat3FromValues,
  mat3Clone,
  mat3Multiply,
  mat3Compose,
  mat3Determinant,
  mat3Invert,
  mat3ApplyToPoint,
  mat3ApplyToXY,
  mat3Translate,
  mat3Scale,
  mat3RotateDeg,
  mat3SkewDeg,
  mat3Flip,
  mat3IsFinite,
  mat3IsAffine,
  mat3FrobeniusNorm,
} from "./matrix";

export {
  type Size,
  type Bounds,
  type AffineDecomposition,
  type GroupTransformDelta,
  type GroupTransformLayer,
  type GroupTransformResult,
  composeTransform,
  composeInverseTransform,
  decomposeAffine,
  recomposeAffine,
  transformedCorners,
  transformedBounds,
  unionBounds,
  applyGroupTransform,
} from "./transform";

export {
  type Quad,
  type QuadValidation,
  type HomographyResult,
  type HomographyFailure,
  type RasterLike,
  type WarpBounds,
  MIN_QUAD_AREA,
  quadSignedArea,
  validateQuad,
  isValidQuad,
  solveSquareToQuad,
  solveRectToQuad,
  solveQuadToQuad,
  applyHomography,
  warpRaster,
} from "./homography";

export {
  type SourceSize,
  isValidCrop,
  clampCrop,
  croppedSize,
} from "./crop";

export {
  MM_PER_INCH,
  type RulerTick,
  type RulerTickOptions,
  pxToUnit,
  unitToPx,
  generateRulerTicks,
} from "./rulers";

export {
  type SnapCandidates,
  type SnapResult,
  type GuideHit,
  computeSnap,
  computePointSnap,
  hitTestGuides,
} from "./snapping";

export {
  type AlignMode,
  type DistributeAxis,
  type AlignItem,
  type AlignDelta,
  selectionBounds,
  alignBounds,
  alignToSelection,
  distributeBounds,
} from "./alignment";
