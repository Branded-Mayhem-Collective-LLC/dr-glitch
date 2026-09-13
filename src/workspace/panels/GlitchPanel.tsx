/**
 * Glitch panel — slice/warp, diffusion glitches, and datamosh controls.
 * Content relocated from the former stage-inspector "05 Glitch" step.
 */

import NumericField from "../../studio/NumericField";
import { useStudioApi } from "../studio-api";
import { PresetsSection } from "./PresetsSection";

export function GlitchPanel() {
  const api = useStudioApi();
  const { settings } = api;

  return (
    <div className="ws-panel-stack">
      {!settings.diffusionEnabled ? (
        <>
          <div className="diffusion-section-label">Slice and warp</div>
          <div className="field-grid">
            <NumericField
              id="sliceShift"
              label="Slice shift"
              value={settings.sliceShift ?? 0}
              min={0}
              max={150}
              step={1}
              unit="px"
              defaultValue={0}
              onChange={(value) => api.updateSetting("sliceShift", value)}
            />
            <NumericField
              id="sliceSize"
              label="Slice size"
              value={settings.sliceSize ?? 20}
              min={2}
              max={200}
              step={1}
              unit="px"
              defaultValue={20}
              disabled={(settings.sliceShift ?? 0) === 0}
              onChange={(value) => api.updateSetting("sliceSize", value)}
            />
            <NumericField
              id="verticalSliceShift"
              label="Vertical slice shift"
              value={settings.verticalSliceShift ?? 0}
              min={0}
              max={150}
              step={1}
              unit="px"
              defaultValue={0}
              onChange={(value) =>
                api.updateSetting("verticalSliceShift", value)
              }
            />
            <NumericField
              id="verticalSliceSize"
              label="Vertical slice size"
              value={settings.verticalSliceSize ?? 20}
              min={2}
              max={200}
              step={1}
              unit="px"
              defaultValue={20}
              disabled={(settings.verticalSliceShift ?? 0) === 0}
              onChange={(value) => api.updateSetting("verticalSliceSize", value)}
            />
            <NumericField
              id="gridWarp"
              label="Grid warp"
              value={settings.gridWarp ?? 0}
              min={0}
              max={200}
              step={1}
              unit="px"
              defaultValue={0}
              onChange={(value) => api.updateSetting("gridWarp", value)}
            />
            <NumericField
              id="warpScale"
              label="Warp scale"
              value={settings.warpScale ?? 100}
              min={10}
              max={500}
              step={1}
              unit="%"
              defaultValue={100}
              disabled={(settings.gridWarp ?? 0) === 0}
              onChange={(value) => api.updateSetting("warpScale", value)}
            />
          </div>
        </>
      ) : (
        <>
          <div className="diffusion-section-label">Diffusion glitches</div>
          <div className="field-grid">
            <NumericField
              id="brokenKernel"
              label="Broken kernel"
              value={Math.round((settings.brokenKernel ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              defaultValue={0}
              onChange={(value) =>
                api.updateSetting("brokenKernel", value / 100)
              }
            />
            <NumericField
              id="directionalBias"
              label="Directional bias"
              value={Math.round((settings.directionalBias ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              defaultValue={0}
              onChange={(value) =>
                api.updateSetting("directionalBias", value / 100)
              }
            />
            <NumericField
              id="directionalBiasAngle"
              label="Bias angle"
              value={settings.directionalBiasAngle ?? 0}
              min={0}
              max={360}
              step={1}
              unit="°"
              defaultValue={0}
              disabled={(settings.directionalBias ?? 0) === 0}
              onChange={(value) =>
                api.updateSetting("directionalBiasAngle", value)
              }
            />
            <NumericField
              id="errorOverflow"
              label="Error overflow"
              value={Math.round((settings.errorOverflow ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              defaultValue={0}
              onChange={(value) =>
                api.updateSetting("errorOverflow", value / 100)
              }
            />
            <NumericField
              id="diffusionReset"
              label="Diffusion reset"
              value={Math.round((settings.diffusionReset ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              defaultValue={0}
              onChange={(value) =>
                api.updateSetting("diffusionReset", value / 100)
              }
            />
            <NumericField
              id="crossChannelBleed"
              label="Cross-channel bleed"
              value={Math.round((settings.crossChannelBleed ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              defaultValue={0}
              onChange={(value) =>
                api.updateSetting("crossChannelBleed", value / 100)
              }
            />
          </div>
        </>
      )}
      <div className="diffusion-section-label">Datamosh</div>
      <div className="field-grid">
        <NumericField
          id="smearDrag"
          label="Smear drag"
          value={Math.round((settings.smearDrag ?? 0) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          defaultValue={0}
          onChange={(value) => api.updateSetting("smearDrag", value / 100)}
        />
        <NumericField
          id="smearLength"
          label="Smear length"
          value={settings.smearLength ?? 24}
          min={4}
          max={120}
          step={1}
          unit="px"
          defaultValue={24}
          disabled={(settings.smearDrag ?? 0) === 0}
          onChange={(value) => api.updateSetting("smearLength", value)}
        />
        <label className="toggle-row">
          <span>
            <strong>Vertical smear</strong>
            <small>Drag smear along the Y axis.</small>
          </span>
          <input
            type="checkbox"
            disabled={(settings.smearDrag ?? 0) === 0}
            checked={settings.smearVertical ?? false}
            onChange={(event) =>
              api.updateSetting("smearVertical", event.target.checked)
            }
          />
        </label>
        <NumericField
          id="macroblockCorrupt"
          label="Macroblock corrupt"
          value={Math.round((settings.macroblockCorrupt ?? 0) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          defaultValue={0}
          onChange={(value) =>
            api.updateSetting("macroblockCorrupt", value / 100)
          }
        />
        <NumericField
          id="macroblockDropout"
          label="Dropout mix"
          value={Math.round((settings.macroblockDropout ?? 0.25) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          defaultValue={25}
          disabled={(settings.macroblockCorrupt ?? 0) === 0}
          onChange={(value) =>
            api.updateSetting("macroblockDropout", value / 100)
          }
        />
        <NumericField
          id="blockShift"
          label="Block shift"
          value={Math.round((settings.blockShift ?? 0) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          defaultValue={0}
          onChange={(value) => api.updateSetting("blockShift", value / 100)}
        />
        <NumericField
          id="blockShiftSize"
          label="Block size"
          value={settings.blockShiftSize ?? 16}
          min={4}
          max={64}
          step={1}
          unit="px"
          defaultValue={16}
          onChange={(value) => api.updateSetting("blockShiftSize", value)}
        />
        <NumericField
          id="channelDesync"
          label="Channel desync"
          value={Math.round((settings.channelDesync ?? 0) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          defaultValue={0}
          onChange={(value) => api.updateSetting("channelDesync", value / 100)}
        />
        <NumericField
          id="bitmapSort"
          label="Bitmap sort"
          value={Math.round((settings.bitmapSort ?? 0) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          defaultValue={0}
          onChange={(value) => api.updateSetting("bitmapSort", value / 100)}
        />
        <label className="toggle-row">
          <span>
            <strong>Vertical bitmap sort</strong>
            <small>Sort along the Y axis.</small>
          </span>
          <input
            type="checkbox"
            disabled={(settings.bitmapSort ?? 0) === 0}
            checked={settings.bitmapSortVertical ?? false}
            onChange={(event) =>
              api.updateSetting("bitmapSortVertical", event.target.checked)
            }
          />
        </label>
      </div>

      <button
        type="button"
        className="button secondary"
        onClick={api.resetGlitch}
      >
        Reset glitch controls
      </button>

      <PresetsSection />
    </div>
  );
}
