import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

type Props = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  defaultValue?: number;
  showSlider?: boolean;
  disabled?: boolean;
  onChange: (value: number) => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function decimalsFor(step: number) {
  const value = String(step);
  return value.includes(".") ? value.split(".")[1].length : 0;
}

function quantize(value: number, min: number, max: number, step: number) {
  const precision = Math.min(4, decimalsFor(step));
  const snapped = min + Math.round((value - min) / step) * step;
  return Number(clamp(snapped, min, max).toFixed(precision));
}

function roundClamp(value: number, min: number, max: number, step: number) {
  const precision = Math.min(4, decimalsFor(step));
  return Number(clamp(value, min, max).toFixed(precision));
}

/**
 * One numeric, three synchronized affordances: type, scrub, or slide.
 *
 * Adobe's scrubby-slider convention is preserved on the label and extended
 * to the value itself: drag horizontally, hold Shift for 10× movement, and
 * hold Alt/Option for 0.1× precision. A click without movement selects the
 * value for direct typing.
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
  defaultValue,
  showSlider = true,
  disabled = false,
  onChange,
}: Props) {
  const [draft, setDraft] = useState(String(value));
  const [scrubbing, setScrubbing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurCommitRef = useRef(false);
  const dragState = useRef<{
    startX: number;
    startValue: number;
    moved: boolean;
  } | null>(null);
  const describedBy = [
    unit ? `numeric-${id}-unit` : null,
    hint ? `numeric-${id}-hint` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const sliderPercent = ((clamp(value, min, max) - min) / (max - min)) * 100;

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

    const next = quantize(parsed, min, max, step);
    setDraft(String(next));
    onChange(next);
  }

  function modifierStep(event: { shiftKey: boolean; altKey: boolean }) {
    if (event.shiftKey) return step * 10;
    if (event.altKey) return step / 10;
    return step;
  }

  function adjustBy(direction: -1 | 1, event: KeyboardEvent<HTMLInputElement>) {
    const activeStep = modifierStep(event);
    const next = roundClamp(
      value + direction * activeStep,
      min,
      max,
      activeStep,
    );
    setDraft(String(next));
    onChange(next);
  }

  function onScrubStart(event: PointerEvent<HTMLElement>) {
    if (disabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    dragState.current = {
      startX: event.clientX,
      startValue: value,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onScrubMove(event: PointerEvent<HTMLElement>) {
    const state = dragState.current;
    if (!state) return;

    const delta = event.clientX - state.startX;
    if (!state.moved && Math.abs(delta) < 3) return;
    state.moved = true;
    setScrubbing(true);
    const activeStep = modifierStep(event);
    const next = roundClamp(
      state.startValue + delta * activeStep,
      min,
      max,
      activeStep,
    );
    setDraft(String(next));
    onChange(next);
  }

  function finishScrub(event: PointerEvent<HTMLElement>, cancelled = false) {
    const state = dragState.current;
    if (!state) return;
    dragState.current = null;
    setScrubbing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!cancelled && !state.moved) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }

  return (
    <div
      className={`numeric-field ${scrubbing ? "is-scrubbing" : ""} ${disabled ? "is-disabled" : ""}`}
      data-testid={`numeric-${id}-field`}
      data-state={disabled ? "inapplicable" : "active"}
    >
      <label className="numeric-label" htmlFor={`numeric-${id}`}>
        <span
          className="numeric-grip"
          data-testid={`numeric-${id}-grip`}
          title="Drag to adjust · Shift 10× · Alt/Option 0.1×"
          onPointerDown={onScrubStart}
          onPointerMove={onScrubMove}
          onPointerUp={(event) => finishScrub(event)}
          onPointerCancel={(event) => finishScrub(event, true)}
          onDoubleClick={() => {
            if (defaultValue === undefined) return;
            const next = quantize(defaultValue, min, max, step);
            setDraft(String(next));
            onChange(next);
          }}
          role="presentation"
          aria-disabled={disabled}
        >
          {label}
        </span>
      </label>
      <span
        className="numeric-entry"
        data-testid={`numeric-${id}-scrub`}
        title="Click to type · Drag to adjust · Shift 10× · Alt/Option 0.1×"
        onPointerDown={onScrubStart}
        onPointerMove={onScrubMove}
        onPointerUp={(event) => finishScrub(event)}
        onPointerCancel={(event) => finishScrub(event, true)}
      >
        <input
          ref={inputRef}
          id={`numeric-${id}`}
          data-testid={`numeric-${id}`}
          className="numeric-input"
          type="text"
          disabled={disabled}
          inputMode="decimal"
          value={draft}
          aria-describedby={describedBy || undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (skipBlurCommitRef.current) {
              skipBlurCommitRef.current = false;
              setDraft(String(value));
              return;
            }
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              adjustBy(1, event);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              adjustBy(-1, event);
            } else if (event.key === "Enter") {
              commit();
            } else if (event.key === "Escape") {
              skipBlurCommitRef.current = true;
              setDraft(String(value));
              event.currentTarget.blur();
            }
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
      {showSlider ? (
        <span className="numeric-slider-shell">
          <span
            className="numeric-slider-fill"
            style={{ width: `${sliderPercent}%` }}
            aria-hidden="true"
          />
          <input
            className="numeric-slider"
            data-testid={`numeric-${id}-slider`}
            type="range"
            disabled={disabled}
            min={min}
            max={max}
            step={step}
            value={value}
            aria-label={`${label} slider`}
            aria-valuetext={`${value}${unit ? ` ${unit}` : ""}`}
            aria-describedby={describedBy || undefined}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </span>
      ) : null}
      {hint ? (
        <p id={`numeric-${id}-hint`} className="numeric-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
