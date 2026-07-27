import { useEffect } from "react";
import { PLATES, type Plate } from "./halftone";

type Handlers = {
  onSolo: (plate: Plate) => void;
  onCellSizeDelta: (delta: number) => void;
};

export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** Space keeps its native activation behavior on every interactive control. */
export function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"])',
    ),
  );
}

/** §7 keyboard map: 1–4 solo, ` composite, [ ] cell size. */
export function useStudioKeys({ onSolo, onCellSizeDelta }: Handlers) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never hijack keys while the operator is typing a value.
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "`") {
        event.preventDefault();
        onSolo("composite");
        return;
      }

      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= PLATES.length) {
        event.preventDefault();
        onSolo(PLATES[index - 1]);
        return;
      }

      if (event.key === "]") {
        event.preventDefault();
        onCellSizeDelta(1);
        return;
      }

      if (event.key === "[") {
        event.preventDefault();
        onCellSizeDelta(-1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSolo, onCellSizeDelta]);
}
