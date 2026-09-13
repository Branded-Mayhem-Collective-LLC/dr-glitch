/**
 * ModalDialog — the single modality primitive behind every custom dialog in
 * the workstation (DirtyWork, Save/Rename Project, Create Snapshot, Save
 * Preset, Home rename/delete/empty-trash, choice dialogs, Help).
 *
 * Guarantees, uniformly:
 * - a pointer-blocking scrim (the dialog portals to document.body above it);
 * - the application root (#root) is made `inert` while any modal is open,
 *   so the background is unreachable by pointer, keyboard, AND assistive
 *   tech (stacked/chained modals refcount the inert state);
 * - a Tab/Shift+Tab focus trap inside the dialog;
 * - deterministic focus restoration: the element focused when the dialog
 *   MOUNTED (the opener) gets focus back when the dialog unmounts, on
 *   Escape and on every choice path alike — skipped automatically when the
 *   opener left the document (e.g. the action navigated away).
 *
 * The dialog CONTENT (role, labelling, Escape handling, initial focus)
 * stays with the wrapped component so existing dialog semantics and the
 * binding selector contract are unchanged.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Refcounted `inert` on the app root; supports stacked/chained modals. */
let inertDepth = 0;

function appRoot(): HTMLElement | null {
  return document.getElementById("root");
}

function pushBackgroundInert(): void {
  inertDepth += 1;
  appRoot()?.setAttribute("inert", "");
}

function popBackgroundInert(): void {
  inertDepth = Math.max(0, inertDepth - 1);
  if (inertDepth === 0) appRoot()?.removeAttribute("inert");
}

export type ModalDialogProps = {
  children: ReactNode;
  /**
   * Restore focus to the opener on unmount (default true). Turn off only
   * when a parent flow owns restoration explicitly.
   */
  restoreFocus?: boolean;
  /** Scrim class; defaults to the shared ws-dialog-scrim. */
  scrimClassName?: string;
  /** Fired when the pointer goes down on the scrim itself (click-outside). */
  onBackdropPointerDown?: () => void;
};

export function ModalDialog({
  children,
  restoreFocus = true,
  scrimClassName = "ws-dialog-scrim",
  onBackdropPointerDown,
}: ModalDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Captured during the first render — BEFORE any child effect moves focus
  // into the dialog — so it is the true opener.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    pushBackgroundInert();
    // Fallback initial focus: children usually focus their preferred
    // control in their own mount effects (which run before this one); when
    // none did, focus the first focusable so keyboard users are inside.
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }
    const opener = openerRef.current;
    return () => {
      // Remove inert BEFORE restoring focus — focus() into an inert
      // subtree is silently ignored.
      popBackgroundInert();
      if (restoreFocus && opener && opener.isConnected) {
        opener.focus();
      }
    };
    // restoreFocus is fixed for the dialog's lifetime by contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Tab") return;
    const container = containerRef.current;
    if (!container) return;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => element.offsetParent !== null || element === document.activeElement);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className={scrimClassName}
      ref={containerRef}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onBackdropPointerDown?.();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
