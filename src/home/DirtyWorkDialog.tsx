/**
 * Reusable confirm dialogs for the dirty-work guard and other destructive
 * actions. Accessible: role="dialog", labelled, Escape cancels, initial
 * focus lands on the safest action. True modality (scrim, inert background,
 * focus trap, focus restoration to the opener) comes from ModalDialog.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { ModalDialog } from "../workspace/ModalDialog";
import type { DirtyGuardChoice } from "./dirty-guard";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive confirms get alertdialog semantics and focus on Cancel. */
  destructive?: boolean;
  /** Scrim class override (the home surface themes its portaled dialogs). */
  scrimClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  scrimClassName,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const safeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) safeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    // role="dialog" even for destructive confirms: the binding selector
    // contract (docs/specs/2026-09-12-e2e-coverage-map.md §1.6) requires all
    // named dialogs — "Delete Permanently", "Empty Trash", "Rename Project",
    // "Unsaved changes" — to match getByRole("dialog", { name }).
    <ModalDialog {...(scrimClassName ? { scrimClassName } : {})}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="confirm-dialog-actions">
          <button type="button" ref={destructive ? safeRef : undefined} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" ref={destructive ? undefined : safeRef} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

export type DirtyWorkDialogProps = {
  open: boolean;
  projectTitle: string;
  /** What proceeding will do, e.g. "create a new project". */
  actionLabel: string;
  onChoice: (choice: DirtyGuardChoice) => void;
};

/**
 * Save / Discard / Cancel prompt used by guardDirtyWork's `choose`.
 * Cancel is the focused default; Discard is visually the destructive path.
 * role="dialog" (not alertdialog) per the workspace-a11y selector contract:
 * `getByRole("dialog", { name: "Unsaved changes" })`.
 */
export function DirtyWorkDialog({ open, projectTitle, actionLabel, onChoice }: DirtyWorkDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <ModalDialog>
      <div
        className="confirm-dialog dirty-work-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onChoice("cancel");
          }
        }}
      >
        <h2 id={titleId}>Unsaved changes</h2>
        <p id={descriptionId}>
          “{projectTitle}” has unsaved changes. Save before you {actionLabel}?
        </p>
        <div className="confirm-dialog-actions">
          <button type="button" ref={cancelRef} onClick={() => onChoice("cancel")}>
            Cancel
          </button>
          <button type="button" className="is-destructive" onClick={() => onChoice("discard")}>
            Discard
          </button>
          <button type="button" onClick={() => onChoice("save")}>
            Save
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
