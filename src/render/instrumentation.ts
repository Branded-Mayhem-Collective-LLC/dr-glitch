/**
 * Allocation instrumentation and the per-realm memory ledger.
 *
 * WHY: the planner (planner.ts) models the peak retained bytes of a render;
 * that model is only honest if the real code paths can be OBSERVED. Every
 * large allocation the render subsystem makes (Float32 fields, RGBA rasters,
 * tile canvases, accumulators, proof fields, app-side collectors, encoder
 * staging, blobs) flows through the helpers below, which notify an optional
 * per-realm observer. Production installs nothing — the fast path is a
 * single null check. Tests install a MemoryLedger and compare its observed
 * peak against the planner's MODEL for the same job; the benchmark harness
 * installs one to report the observed ledger next to browser-measured memory.
 *
 * SCOPE — PER-REALM DIAGNOSTIC ONLY: the observer registry is a module
 * global, so a dedicated worker has its OWN instrumentation instance; an
 * observer installed on the page sees app-realm allocations only, and one
 * installed inside a worker (or a shared-thread MainThreadRenderer test)
 * sees that realm. Ledger numbers must never be presented as whole-process
 * measurements — performance.measureUserAgentSpecificMemory is the honest
 * process-wide meter (the browser benchmark's memory gate uses it
 * exclusively).
 *
 * RELEASE notifications are made at the points where the code DROPS its last
 * reference (JS cannot free explicitly); the ledger therefore tracks logical
 * retention — exactly what the planner models. Actual GC may lag, which is
 * why the browser benchmark also measures real memory.
 *
 * PARITY: these helpers change no arithmetic. allocField/copyField produce
 * exactly `new Float32Array(n)` / `field.slice()`; release helpers only
 * notify. The kernel parity suites run with and without an observer.
 */

export type AllocationKind =
  | "field" // Float32 kernel fields (coverage/glitch/diffusion/ink)
  | "raster" // RGBA pixel buffers (sources, warped layers, proofs)
  | "accumulator" // plate ink/alpha accumulators
  | "proof" // proof accumulator fields
  | "band" // band-height working buffers
  | "canvas" // OffscreenCanvas / ImageData staging
  | "bitmap" // ImageBitmap stamps
  | "collector" // app-side composite collector fields
  | "encode" // encoder staging (canvas backing, ImageData)
  | "blob" // encoded output blobs retained until delivery
  | "placements"; // packed dot placement buffers

export type AllocationObserver = {
  alloc(bytes: number, kind: AllocationKind, label?: string): void;
  release(bytes: number, kind: AllocationKind, label?: string): void;
};

let observer: AllocationObserver | null = null;

/** Install (or clear with null) THIS REALM's allocation observer (see SCOPE). */
export function setAllocationObserver(next: AllocationObserver | null): void {
  observer = next;
}

export function getAllocationObserver(): AllocationObserver | null {
  return observer;
}

export function noteAlloc(bytes: number, kind: AllocationKind, label?: string): void {
  observer?.alloc(bytes, kind, label);
}

export function noteRelease(bytes: number, kind: AllocationKind, label?: string): void {
  observer?.release(bytes, kind, label);
}

/**
 * Charge retained ownership and return an idempotent release bound to the
 * observer that saw the allocation. This matters for work that can outlive
 * its caller after an abort: swapping/clearing the global observer must not
 * strand a charge in the original ledger or release it into a later one.
 */
export function retainAllocation(
  bytes: number,
  kind: AllocationKind,
  label?: string,
): () => void {
  const owner = observer;
  if (bytes > 0) owner?.alloc(bytes, kind, label);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (bytes > 0) owner?.release(bytes, kind, label);
  };
}

/** `new Float32Array(length)`, observed. */
export function allocField(length: number, kind: AllocationKind = "field", label?: string): Float32Array {
  observer?.alloc(length * 4, kind, label);
  return new Float32Array(length);
}

/** `field.slice()`, observed. */
export function copyField(field: Float32Array, kind: AllocationKind = "field", label?: string): Float32Array {
  observer?.alloc(field.byteLength, kind, label);
  return field.slice();
}

/** Notify that a field's last reference is being dropped. */
export function releaseField(field: Float32Array, kind: AllocationKind = "field", label?: string): void {
  observer?.release(field.byteLength, kind, label);
}

/** Notify retention of an existing RGBA buffer (decode result, transfer). */
export function noteRasterAlloc(byteLength: number, label?: string): void {
  observer?.alloc(byteLength, "raster", label);
}

export function noteRasterRelease(byteLength: number, label?: string): void {
  observer?.release(byteLength, "raster", label);
}

/**
 * PER-REALM memory ledger (see SCOPE above): one honest account of the
 * retained bytes THIS REALM's instrumented code paths hold across
 * worker-modeled and app-side buffers. Install via setAllocationObserver;
 * never present its numbers as whole-process measurements.
 */
export class MemoryLedger implements AllocationObserver {
  currentBytes = 0;
  peakBytes = 0;
  readonly currentByKind = new Map<AllocationKind, number>();
  readonly peakByKind = new Map<AllocationKind, number>();
  /** Net allocation events that were never released (leak detector). */
  liveAllocations = 0;

  alloc(bytes: number, kind: AllocationKind): void {
    this.currentBytes += bytes;
    this.liveAllocations += 1;
    if (this.currentBytes > this.peakBytes) this.peakBytes = this.currentBytes;
    const kindCurrent = (this.currentByKind.get(kind) ?? 0) + bytes;
    this.currentByKind.set(kind, kindCurrent);
    if (kindCurrent > (this.peakByKind.get(kind) ?? 0)) this.peakByKind.set(kind, kindCurrent);
  }

  release(bytes: number, kind: AllocationKind): void {
    this.currentBytes -= bytes;
    this.liveAllocations -= 1;
    this.currentByKind.set(kind, (this.currentByKind.get(kind) ?? 0) - bytes);
  }

  snapshot(): { currentBytes: number; peakBytes: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    for (const [kind, bytes] of this.peakByKind) byKind[kind] = bytes;
    return { currentBytes: this.currentBytes, peakBytes: this.peakBytes, byKind };
  }
}

/* ------------------------------------------------------------------ */
/* Cooperative yielding                                                */
/* ------------------------------------------------------------------ */

/**
 * Yield one REAL macrotask so pending messages (cancel/supersede) can be
 * processed — inside a busy worker, a synchronous kernel can never observe a
 * cancel because onmessage cannot run. MessageChannel is used instead of
 * setTimeout because chained timeouts are clamped to ~4ms past a nesting
 * depth of 5, which would add seconds across the thousands of chunk yields
 * a full-sheet export performs.
 */
let yieldChannel: MessageChannel | null = null;
const yieldQueue: Array<() => void> = [];

export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => {
      yieldQueue.shift()?.();
    };
  }
  return new Promise((resolve) => {
    yieldQueue.push(resolve);
    yieldChannel!.port2.postMessage(null);
  });
}

/**
 * Cooperative checkpoint contract threaded through the chunked kernel
 * drivers: awaited between chunks; implementations yield to the event loop
 * and throw to abort. `undefined` means "run synchronously" (parity path).
 */
export type Checkpoint = (() => void | Promise<void>) | undefined;

/** Rows per cooperative chunk targeting ~2M pixels of work per slice. */
export function chunkRowsFor(width: number, targetPixels = 2_000_000): number {
  return Math.max(1, Math.floor(targetPixels / Math.max(1, width)));
}
