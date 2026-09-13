/**
 * Halftone panel — dot geometry for halftone mode. Content relocated from
 * the former stage-inspector "02 Halftone" step; state still lives in
 * HalftoneStudio and flows through StudioApi.
 */

import NumericField from "../../studio/NumericField";
import { DEFAULT_SETTINGS } from "../../studio/settings-defaults";
import type { HalftoneSettings } from "../../studio/halftone";
import { useProjectUi } from "../project-ui";
import { useStudioApi } from "../studio-api";
import { PresetsSection } from "./PresetsSection";

export function HalftonePanel() {
  const api = useStudioApi();
  const project = useProjectUi();
  const { settings } = api;
  const primary =
    project.layers.find((layer) => layer.id === project.primaryLayerId) ?? null;
  const mode = primary?.recipe.mode ?? null;
  const cleanMode = mode === "clean";
  const inactive = cleanMode || settings.diffusionEnabled;

  return (
    <div className="ws-panel-stack">
      {settings.diffusionEnabled && (
        <p className="control-state-note" role="status">
          Saved for Halftone mode. These controls do not alter diffusion
          output.
        </p>
      )}
      {cleanMode && primary && (
        <div className="control-state-note" role="status" data-testid="halftone-clean-note">
          <p>
            This layer is in CLEAN mode: it prints continuous tone with no
            screening, so Halftone settings are saved but inactive. Vector
            plates are unavailable while a clean layer contributes.
          </p>
          <button
            type="button"
            className="button secondary"
            data-testid="halftone-use-halftone"
            disabled={primary.locked}
            onClick={() => project.setLayerMode(primary.id, "halftone")}
          >
            Use Halftone
          </button>
        </div>
      )}
      <fieldset className="mode-fieldset" disabled={inactive}>
        <div className="halftone-cmyk-top-controls">
          <label className="select-field">
            <span>Dot shape</span>
            <select
              value={settings.dotShape}
              onChange={(event) => {
                if (event.target.value === "custom") {
                  api.openCustomShapeDialog();
                } else {
                  api.updateSetting(
                    "dotShape",
                    event.target.value as HalftoneSettings["dotShape"],
                  );
                }
              }}
            >
              <option value="round">Round</option>
              <option value="square">Square</option>
              <option value="diamond">Diamond</option>
              <option value="line">Line</option>
              <option value="triangle">Triangle</option>
              <option value="cross">Cross</option>
              <option value="circle-outline">Circle outline</option>
              <option value="custom">Custom</option>
            </select>
          </label>
        </div>
        {settings.customShape && (
          <div className="custom-shape-current">
            <span data-testid="current-custom-shape">
              {settings.customShape.filename}
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={api.openCustomShapeDialog}
            >
              Replace SVG
            </button>
          </div>
        )}
        <div className="field-grid">
          {settings.dotShape === "circle-outline" && (
            <NumericField
              id="strokeWidth"
              label="Outline stroke"
              value={settings.strokeWidth ?? 1}
              min={0.25}
              max={10}
              step={0.01}
              unit="px"
              defaultValue={1}
              hint="Thickness inside the circle, in 240-DPI document pixels."
              onChange={(value) => api.updateSetting("strokeWidth", value)}
            />
          )}
          <NumericField
            id="cellSize"
            label="Cell size"
            value={settings.cellSize}
            min={3}
            max={64}
            step={1}
            unit="px"
            defaultValue={DEFAULT_SETTINGS.cellSize}
            hint="At 240 DPI, 16 px yields about 15 LPI; 4 px yields about 60 LPI."
            onChange={(value) => api.updateSetting("cellSize", value)}
          />
          <NumericField
            id="frayedXEdge"
            label="Frayed X edge"
            value={settings.frayedXEdge}
            min={0}
            max={100}
            step={1}
            unit="px"
            defaultValue={0}
            hint="Frays the left and right edges of the halftone field."
            onChange={(value) => api.updateSetting("frayedXEdge", value)}
          />
          <NumericField
            id="frayedYEdge"
            label="Frayed Y edge"
            value={settings.frayedYEdge}
            min={0}
            max={100}
            step={1}
            unit="px"
            defaultValue={0}
            hint="Frays the top and bottom edges of the halftone field."
            onChange={(value) => api.updateSetting("frayedYEdge", value)}
          />
        </div>
      </fieldset>

      <button
        type="button"
        className="button secondary"
        onClick={api.resetHalftone}
      >
        Reset halftone / CMYK controls
      </button>

      <PresetsSection />
    </div>
  );
}
