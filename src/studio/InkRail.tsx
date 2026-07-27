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
        }. Enter to solo. Alt+Enter to ${visible ? "hide" : "show"}.`;
        return (
          <button
            key={plate}
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
              // Alt+Enter: Chromium never synthesizes a click here (holding
              // Alt suppresses the default Enter-activates-button behavior
              // outright), so this is a direct intercept, not a fallback for
              // a flaky native path. preventDefault to stop any browser
              // chrome (e.g. a stray form submit) from reacting to the
              // Enter keydown once we've handled it ourselves.
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
            <span className="ink-chip-angle">{angle}°</span>
          </button>
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
