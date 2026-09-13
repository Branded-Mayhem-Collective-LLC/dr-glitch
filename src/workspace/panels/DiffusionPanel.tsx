/**
 * Diffusion panel — error-diffusion mode toggle and texture controls.
 * Content relocated from the former stage-inspector "04 Diffusion" step.
 */

import NumericField from "../../studio/NumericField";
import type { HalftoneSettings } from "../../studio/halftone";
import { useStudioApi } from "../studio-api";
import { PresetsSection } from "./PresetsSection";

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function DiffusionPanel() {
  const api = useStudioApi();
  const { settings } = api;

  return (
    <div className="ws-panel-stack">
      <label className="toggle-row">
        <span>
          <strong>Enable diffusion</strong>
          <small>Quantize coverage with an error-diffusion texture.</small>
        </span>
        <input
          type="checkbox"
          checked={settings.diffusionEnabled ?? false}
          onChange={(event) =>
            api.updateSetting("diffusionEnabled", event.target.checked)
          }
        />
      </label>
      {!settings.diffusionEnabled && (
        <p className="control-state-note">
          Available when Diffusion mode is enabled. Saved values are retained.
        </p>
      )}
      <fieldset className="mode-fieldset" disabled={!settings.diffusionEnabled}>
        <div className="diffusion-section-label">Diffusion</div>
        <div className="field-grid">
          <label className="select-field">
            <span>Algorithm</span>
            <select
              value={settings.diffusionAlgorithm ?? "floyd-steinberg"}
              onChange={(event) =>
                api.updateSetting(
                  "diffusionAlgorithm",
                  event.target.value as HalftoneSettings["diffusionAlgorithm"],
                )
              }
            >
              <option value="none">None</option>
              <option value="floyd-steinberg">Floyd-Steinberg</option>
              <option value="jarvis-judice-ninke">Jarvis-Judice-Ninke</option>
              <option value="stucki">Stucki</option>
              <option value="burkes">Burkes</option>
              <option value="atkinson">Atkinson</option>
            </select>
          </label>
          <label className="select-field">
            <span>Modulation</span>
            <select
              value={settings.diffusionModulation ?? "none"}
              onChange={(event) =>
                api.updateSetting(
                  "diffusionModulation",
                  event.target.value as HalftoneSettings["diffusionModulation"],
                )
              }
            >
              {(
                [
                  "none",
                  "column",
                  "row",
                  "dispersed",
                  "medium",
                  "heavy",
                  "circuit",
                  "tilt",
                  "grid",
                ] as const
              ).map((mode) => (
                <option key={mode} value={mode}>
                  {titleCase(mode)}
                </option>
              ))}
            </select>
          </label>
          <NumericField
            id="diffusionModStrength"
            label="Modulation strength"
            value={Math.round((settings.diffusionModStrength ?? 0.5) * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            defaultValue={50}
            disabled={(settings.diffusionModulation ?? "none") === "none"}
            onChange={(value) =>
              api.updateSetting("diffusionModStrength", value / 100)
            }
          />
          <NumericField
            id="diffusionIntensity"
            label="Intensity"
            value={Math.round((settings.diffusionIntensity ?? 0.5) * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            defaultValue={50}
            onChange={(value) =>
              api.updateSetting("diffusionIntensity", value / 100)
            }
          />
          <NumericField
            id="diffusionLevels"
            label="Levels"
            value={settings.diffusionLevels ?? 8}
            min={2}
            max={32}
            step={1}
            unit=""
            defaultValue={8}
            onChange={(value) => api.updateSetting("diffusionLevels", value)}
          />
          <NumericField
            id="diffusionSharpenStrength"
            label="Sharpen strength"
            value={Math.round((settings.diffusionSharpenStrength ?? 0) * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            defaultValue={0}
            onChange={(value) =>
              api.updateSetting("diffusionSharpenStrength", value / 100)
            }
          />
          <NumericField
            id="diffusionSharpenRadius"
            label="Sharpen radius"
            value={settings.diffusionSharpenRadius ?? 1}
            min={1}
            max={10}
            step={1}
            unit="px"
            defaultValue={1}
            disabled={(settings.diffusionSharpenStrength ?? 0) === 0}
            onChange={(value) =>
              api.updateSetting("diffusionSharpenRadius", value)
            }
          />
          <NumericField
            id="diffusionDenoise"
            label="Denoise / noise"
            value={Math.round((settings.diffusionDenoise ?? 0) * 100)}
            min={-100}
            max={100}
            step={1}
            unit="%"
            defaultValue={0}
            onChange={(value) =>
              api.updateSetting("diffusionDenoise", value / 100)
            }
          />
        </div>
      </fieldset>

      <button
        type="button"
        className="button secondary"
        onClick={api.resetDiffusion}
      >
        Reset diffusion controls
      </button>

      <PresetsSection />
    </div>
  );
}
