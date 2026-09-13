/**
 * Injectable time sources. All storage business logic that depends on wall
 * time (trash expiry, lease TTLs, recovery debounce) takes these instead of
 * touching Date/setTimeout directly so unit tests can run on a fake clock.
 */

/** Returns the current epoch time in milliseconds. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export type TimerHandle = unknown;

export type TimerHost = {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
};

export const systemTimer: TimerHost = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
