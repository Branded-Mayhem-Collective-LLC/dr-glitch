import { CHROME_INK } from "./inks";
import {
  PLATES,
  PLATE_META,
  type HalftoneSettings,
  type Plate,
} from "./halftone";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";

type ProcessPlate = Exclude<Plate, "composite">;

type Props = {
  activePlate: Plate;
  settings: HalftoneSettings;
  onSolo: (plate: Plate) => void;
  onToggleVisible: (plate: ProcessPlate) => void;
  onAngleChange: (plate: ProcessPlate, angle: number) => void;
};

function normalizeAngle(value: number) {
  return ((value % 360) + 360) % 360;
}

function InlineAngleField({
  plate,
  label,
  value,
  onChange,
}: {
  plate: ProcessPlate;
  label: string;
  value: number;
  onChange: (plate: ProcessPlate, angle: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const dragState = useRef<{ startX: number; startValue: number } | null>(null);
  const unitId = `ink-angle-${plate}-unit`;
  const hintId = `ink-angle-${plate}-hint`;

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
    const next = normalizeAngle(parsed);
    setDraft(String(next));
    onChange(plate, next);
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
    onChange(plate, normalizeAngle(state.startValue + delta * scale));
  }

  function onPointerUp(event: PointerEvent<HTMLSpanElement>) {
    dragState.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="ink-chip-angle-field">
      <span
        className="ink-chip-angle-grip"
        data-testid={`ink-angle-${plate}-grip`}
        title={`Drag to adjust ${label} angle`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        aria-hidden="true"
      >
        ↔
      </span>
      <input
        className="ink-chip-angle-input"
        data-testid={`ink-angle-${plate}`}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(String(value));
        }}
        aria-label={`${label} screen angle in degrees`}
        aria-describedby={`${unitId} ${hintId}`}
      />
      <span id={unitId}>°</span>
      <span id={hintId} className="sr-only">
        Sets screen rotation from 0 through 359 degrees. Drag the adjacent
        handle for rough adjustment.
      </span>
    </div>
  );
}

/**
 * §6.1 Ink rail. Persistent, always-visible C/M/Y/K + composite strip.
 * Click a chip = solo that plate. Alt-click or Meta-click = toggle its
 * visibility without changing the soloed view.
 *
 * §9: plate identity is never carried by hue alone — every chip pairs its
 * ink swatch with its letter (C/M/Y/K) AND its angle value.
 *
 * Keyboard + screen-reader parity for the visibility toggle: verified
 * empirically (not assumed) which modifier+activation combo actually fires
 * a click with altKey set on a focused <button> in Chromium. Plain Enter
 * and plain Space both solo, as expected. Alt+Space reliably fires a click
 * with altKey=true via the browser's native click synthesis — Chromium
 * carries the held modifier into the keyup-triggered click, no extra code
 * needed. Alt+Enter does NOT synthesize a click: holding Alt suppresses the
 * browser's default Enter-activates-button behavior entirely (confirmed via
 * a live listener — the keydown/keyup fire, focus is retained, but no click
 * event follows).
 *
 * That only rules out relying on native click synthesis for Alt+Enter — it
 * doesn't rule out Alt+Enter itself. A direct onKeyDown intercept bypasses
 * synthesis and calls onToggleVisible straight from the keydown handler.
 * Alt+Enter is the documented PRIMARY gesture (symmetric with Alt-click, the
 * first thing a user would guess, and it dodges Alt+Space's Windows
 * collision with the native window system-menu shortcut). Alt+Space is kept
 * working as an unadvertised secondary path — it costs nothing extra, since
 * it already works through the existing altKey check in onClick below.
 *
 * aria-label (not just the hover-only title) states plate identity, angle,
 * current visibility, and the primary gesture, so both sighted-mouse and
 * screen-reader users get the same information. A quiet on-screen hint line
 * (§7: "every control states its consequence in one line of plain
 * language") gives sighted keyboard-only users — who see neither title nor
 * aria-label — the same discoverability.
 *
 * The editable angle is a sibling of the solo button, never nested inside
 * it. A visually hidden angle in the button keeps plate identity intact for
 * the button's text fallback while the adjacent input is the visible editor.
 */
export default function InkRail({
  activePlate,
  settings,
  onSolo,
  onToggleVisible,
  onAngleChange,
}: Props) {
  return (
    <div className="ink-rail" role="group" aria-label="Plates">
      <button
        type="button"
        data-testid="ink-chip-composite"
        className={`ink-chip ink-chip-composite ${activePlate === "composite" ? "is-active" : ""}`}
        aria-pressed={activePlate === "composite"}
        aria-label="Composite, all four plates together"
        title="Composite — all plates together"
        onClick={() => onSolo("composite")}
      >
        <span
          className="ink-chip-swatch ink-chip-swatch-composite"
          aria-hidden="true"
        >
          <span style={{ background: CHROME_INK.cyan }} />
          <span style={{ background: CHROME_INK.magenta }} />
          <span style={{ background: CHROME_INK.yellow }} />
          <span style={{ background: CHROME_INK.black }} />
        </span>
        <span className="ink-chip-letter">ALL</span>
      </button>

      {PLATES.map((plate) => {
        const visible = settings.visible[plate];
        const isHiddenAndActive = activePlate === plate && !visible;
        const meta = PLATE_META[plate];
        const angle = settings.angles[plate];
        // §9: the accessible name carries plate identity AND hidden/visible
        // state — data-visible alone exposes nothing to assistive tech.
        const ariaLabel = `${meta.label} plate, angle ${angle} degrees, ${
          visible ? "visible" : "hidden"
        }. Enter to solo. Alt+Enter to ${visible ? "hide" : "show"}.`;
        return (
          <div className="ink-chip-row" key={plate}>
            <button
              type="button"
              data-testid={`ink-chip-${plate}`}
              className={`ink-chip ${activePlate === plate ? "is-active" : ""}`}
              aria-pressed={activePlate === plate}
              aria-label={ariaLabel}
              data-visible={visible ? "true" : "false"}
              title={`${meta.label} — click to solo, Alt-click (or focus + Alt+Enter) to hide${isHiddenAndActive ? " (currently hidden — plate renders blank)" : ""}`}
              onClick={(event) => {
                if (event.altKey || event.metaKey) {
                  onToggleVisible(plate);
                  return;
                }
                onSolo(plate);
              }}
              onKeyDown={(event) => {
                if (event.altKey && event.key === "Enter") {
                  event.preventDefault();
                  onToggleVisible(plate);
                }
              }}
            >
              <span
                className="ink-chip-swatch"
                style={{ background: CHROME_INK[plate] }}
                aria-hidden="true"
              />
              <span className="ink-chip-letter">{meta.short}</span>
              <span className="sr-only">{angle} degrees</span>
            </button>
            <InlineAngleField
              plate={plate}
              label={meta.label}
              value={angle}
              onChange={onAngleChange}
            />
          </div>
        );
      })}

      {/*
       * §7: every control states its consequence in one line of plain
       * language. aria-label and title cover screen-reader and hover users;
       * this line is for a sighted keyboard-only user tabbing through the
       * rail, who sees neither. Kept quiet (micro-label style) so it
       * doesn't compete with the proof.
       */}
      <p className="ink-rail-hint" data-testid="ink-rail-hint">
        Click to solo · Alt-click or Alt+Enter to hide
      </p>
    </div>
  );
}
