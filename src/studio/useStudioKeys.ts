/**
 * Target classification helpers for global key handling.
 *
 * The studio-wide single-key shortcuts (plate solo 1–4, ` composite, [ ]
 * cell size, tool keys) moved to the centralized registry in
 * src/workspace/shortcuts.ts. This module keeps the DOM-aware target checks
 * used by the space-drag pan gesture.
 */

export { isTypingTarget } from "../workspace/shortcuts";

/** Space keeps its native activation behavior on every interactive control. */
export function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"])',
    ),
  );
}
