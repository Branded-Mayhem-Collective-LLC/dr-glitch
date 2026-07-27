import { CHROME_INK } from "./inks";
import {
  PLATES,
  PLATE_META,
  type HalftoneSettings,
  type Plate,
} from "./halftone";

type Props = {
  activePlate: Plate;
  settings: HalftoneSettings;
  onSolo: (plate: Plate) => void;
  onToggleVisible: (plate: Exclude<Plate, "composite">) => void;
};

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
 * with altKey=true — Chromium carries the held modifier into the keyup-
 * triggered click. Alt+Enter does NOT: holding Alt suppresses the browser's
 * default Enter-activates-button behavior entirely (no click event fires
 * at all — confirmed via a live listener, not inferred from a no-op
 * result). So the discoverable, documented keyboard gesture is Alt+Space,
 * not Alt+Enter. aria-label (not just the hover-only title) states plate
 * identity, angle, current visibility, and that gesture, so both
 * sighted-mouse and screen-reader users get the same information.
 *
 * Markup note (Task 5 ambiguity, resolved): chips render as a single
 * <button> per §9's requirement that letter + angle live together in one
 * text-queryable element. Task 7 (editable angle) cannot nest an <input>
 * inside this <button> — it will need to restructure each chip into a row
 * (e.g. a wrapping <div> holding this button for the solo/letter target
 * plus a sibling <input> for the angle) rather than add the input here.
 */
export default function InkRail({
  activePlate,
  settings,
  onSolo,
  onToggleVisible,
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
        }. Enter to solo. Alt+Space to ${visible ? "hide" : "show"}.`;
        return (
          <button
            key={plate}
            type="button"
            data-testid={`ink-chip-${plate}`}
            className={`ink-chip ${activePlate === plate ? "is-active" : ""}`}
            aria-pressed={activePlate === plate}
            aria-label={ariaLabel}
            data-visible={visible ? "true" : "false"}
            title={`${meta.label} — click to solo, Alt-click (or focus + Alt+Space) to hide${isHiddenAndActive ? " (currently hidden — plate renders blank)" : ""}`}
            onClick={(event) => {
              if (event.altKey || event.metaKey) {
                onToggleVisible(plate);
                return;
              }
              onSolo(plate);
            }}
          >
            <span
              className="ink-chip-swatch"
              style={{ background: CHROME_INK[plate] }}
              aria-hidden="true"
            />
            <span className="ink-chip-letter">{meta.short}</span>
            <span className="ink-chip-angle">{angle}°</span>
          </button>
        );
      })}
    </div>
  );
}
