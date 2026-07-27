import { useEffect, useRef, useState, type PointerEvent } from "react";

type Props = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  onChange: (value: number) => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * §7: type-or-drag. A typed input is the primary affordance; dragging the
 * label is a secondary shortcut for rough adjustment.
 */
export default function NumericField({
  id,
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  onChange,
}: Props) {
  const [draft, setDraft] = useState(String(value));
  const dragState = useRef<{ startX: number; startValue: number } | null>(null);
  const describedBy = [
    unit ? `numeric-${id}-unit` : null,
    hint ? `numeric-${id}-hint` : null,
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    if (draft.trim() === "") {
      setDraft(String(value));
      return;
    }

    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }

    const next = clamp(parsed, min, max);
    setDraft(String(next));
    onChange(next);
  }

  function onPointerDown(event: PointerEvent<HTMLSpanElement>) {
    dragState.current = { startX: event.clientX, startValue: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLSpanElement>) {
    const state = dragState.current;
    if (!state) return;

    const delta = event.clientX - state.startX;
    const scale = event.shiftKey ? 0.25 : 1;
    onChange(clamp(state.startValue + delta * step * scale, min, max));
  }

  function onPointerUp(event: PointerEvent<HTMLSpanElement>) {
    dragState.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="numeric-field">
      <label className="numeric-label" htmlFor={`numeric-${id}`}>
        <span
          className="numeric-grip"
          data-testid={`numeric-${id}-grip`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="presentation"
        >
          {label}
        </span>
      </label>
      <span className="numeric-entry">
        <input
          id={`numeric-${id}`}
          data-testid={`numeric-${id}`}
          className="numeric-input"
          type="text"
          inputMode="decimal"
          value={draft}
          aria-describedby={describedBy || undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(String(value));
          }}
        />
        {unit ? (
          <span
            id={`numeric-${id}-unit`}
            className="numeric-unit"
            data-testid={`numeric-${id}-unit`}
          >
            {unit}
          </span>
        ) : null}
      </span>
      {hint ? (
        <p id={`numeric-${id}-hint`} className="numeric-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
