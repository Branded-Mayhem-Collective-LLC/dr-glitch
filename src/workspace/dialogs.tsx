/**
 * Small shared dialogs for project flows. TextPromptDialog covers every
 * name-entry dialog in the selector contract ("Save Project",
 * "Rename Project", "Create Snapshot", "Save Preset"); ChoiceDialog covers
 * two-way decisions (save conflicts). Accessible names on the dialog and the
 * textbox are part of the binding e2e contract. True modality (scrim, inert
 * background, focus trap, focus restoration) comes from ModalDialog.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ModalDialog } from "./ModalDialog";

export type TextPromptDialogProps = {
  title: string;
  /** Accessible name of the text field, e.g. "Project name". */
  fieldLabel: string;
  submitLabel: string;
  initialValue?: string;
  description?: ReactNode;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

export function TextPromptDialog({
  title,
  fieldLabel,
  submitLabel,
  initialValue = "",
  description,
  onSubmit,
  onCancel,
}: TextPromptDialogProps) {
  const titleId = useId();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <ModalDialog>
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
        {description}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          <input
            ref={inputRef}
            type="text"
            aria-label={fieldLabel}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="confirm-dialog-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={!value.trim()}>
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </ModalDialog>
  );
}

export type ChoiceDialogProps = {
  title: string;
  description?: ReactNode;
  choices: { label: string; onChoose: () => void; destructive?: boolean }[];
  onCancel: () => void;
};

export function ChoiceDialog({ title, description, choices, onCancel }: ChoiceDialogProps) {
  const titleId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  return (
    <ModalDialog>
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
        {description}
        <div className="confirm-dialog-actions">
          <button ref={firstRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              className={choice.destructive ? "is-destructive" : undefined}
              onClick={choice.onChoose}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </ModalDialog>
  );
}
