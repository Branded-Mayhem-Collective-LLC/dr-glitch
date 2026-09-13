/**
 * Shared placement-retention constants for the runtime ledger and planner.
 * Kept dependency-neutral so grid kernels and planning use one model.
 */

/** Conservative V8 DotPlacement object plus backing-array slot estimate. */
export const JS_PLACEMENT_BYTES_PER_DOT = 80;

/** Packed worker-transfer representation: Float64 [x, y, size]. */
export const PACKED_PLACEMENT_BYTES_PER_DOT = 3 * Float64Array.BYTES_PER_ELEMENT;

/** Worst overlap while converting JS placements to their packed transfer. */
export const PLACEMENT_BYTES_PER_DOT =
  JS_PLACEMENT_BYTES_PER_DOT + PACKED_PLACEMENT_BYTES_PER_DOT;
