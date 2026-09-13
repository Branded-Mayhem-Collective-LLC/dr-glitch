/**
 * StrictMode-safe ownership of disposable session objects held in refs.
 *
 * React StrictMode (dev builds) runs every effect setup → cleanup → setup on
 * the same mounted instance WITHOUT re-rendering in between, while refs and
 * state are preserved. A cleanup that disposes a ref-held object therefore
 * leaves the second setup pass — and every later consumer — holding a
 * permanently dead instance. That exact pattern silently killed the studio's
 * AssetCache (pending imageWhenReady waiters hung forever) and
 * PreviewService (a disposed service ignores requests), so the live preview
 * never produced a frame in dev/E2E.
 *
 * `ensureLive` is the one sanctioned accessor for such refs: it returns the
 * held instance only while it is live, and transparently constructs a
 * replacement after disposal. Call it at every read site (render, effect
 * setup, callback) instead of touching `ref.current` directly.
 */

export type Disposable = {
  readonly isDisposed: boolean;
  dispose(): void;
};

export type DisposableSlot<T extends Disposable> = { current: T | null };

/** Returns the slot's instance, constructing a fresh one if missing/disposed. */
export function ensureLive<T extends Disposable>(
  slot: DisposableSlot<T>,
  create: () => T,
): T {
  if (slot.current === null || slot.current.isDisposed) {
    slot.current = create();
  }
  return slot.current;
}
