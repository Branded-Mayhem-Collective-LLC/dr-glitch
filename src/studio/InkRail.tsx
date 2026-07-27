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
        const isHiddenAndActive = activePlate === plate && !settings.visible[plate];
        return (
          <button
            key={plate}
            type="button"
            data-testid={`ink-chip-${plate}`}
            className={`ink-chip ${activePlate === plate ? "is-active" : ""}`}
            aria-pressed={activePlate === plate}
            data-visible={settings.visible[plate] ? "true" : "false"}
            title={`${PLATE_META[plate].label} — click to solo, Alt-click to hide${isHiddenAndActive ? " (currently hidden — plate renders blank)" : ""}`}
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
            <span className="ink-chip-letter">{PLATE_META[plate].short}</span>
            <span className="ink-chip-angle">{settings.angles[plate]}°</span>
          </button>
        );
      })}
    </div>
  );
}
