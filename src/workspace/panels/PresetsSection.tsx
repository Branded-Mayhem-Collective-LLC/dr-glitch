/**
 * Recipe presets section, shared by the Halftone / Diffusion / Glitch
 * panels. Presets are device-global versioned .drpreset recipes (mode +
 * halftone + diffusion + glitch + canonical custom-dot SVG); applying one is
 * an explicit, undoable action against the primary layer.
 *
 * Testids (ws-preset-select / ws-preset-import-input) repeat per panel; the
 * e2e contract always scopes them by panel.
 */

import { useRef, useState } from "react";
import { MAX_PRESET_TEXT_LENGTH } from "../../io/drpreset";
import { useProjectUi } from "../project-ui";
import { TextPromptDialog } from "../dialogs";

export function PresetsSection() {
  const project = useProjectUi();
  const [saveOpen, setSaveOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const selected = project.presets.find((preset) => preset.id === selectedId) ?? null;

  return (
    <section className="ws-presets" aria-label="Recipe presets">
      <h3 className="ws-panel-section-title">Presets</h3>
      <label className="select-field">
        <span>Saved presets</span>
        <select
          data-testid="ws-preset-select"
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          <option value="">
            {project.presets.length === 0 ? "No presets saved yet" : "Choose a preset…"}
          </option>
          {project.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <div className="ws-preset-actions" role="group" aria-label="Preset actions">
        <button
          type="button"
          disabled={!selected || project.readOnly}
          onClick={() => selected && project.applyPreset(selected.id)}
        >
          Apply Preset
        </button>
        <button type="button" disabled={project.readOnly} onClick={() => setSaveOpen(true)}>
          Save Preset
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && project.exportPreset(selected.id)}
        >
          Export Preset
        </button>
        <button type="button" onClick={() => importRef.current?.click()}>
          Import Preset
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            project.deletePreset(selected.id);
            setSelectedId("");
          }}
        >
          Delete Preset
        </button>
      </div>
      <input
        ref={importRef}
        data-testid="ws-preset-import-input"
        type="file"
        accept=".drpreset,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          // Size gate BEFORE any read: an oversized file is rejected here
          // without ever materializing its text (the parser's own cap is the
          // post-read backstop). Mirrors the io drpreset limit.
          if (file.size > MAX_PRESET_TEXT_LENGTH) {
            setImportError(
              `Preset rejected: the file exceeds ${MAX_PRESET_TEXT_LENGTH.toLocaleString()} bytes.`,
            );
            return;
          }
          setImportError(null);
          void project.importPresetFile(file);
        }}
      />
      {importError !== null && (
        <p
          role="alert"
          className="control-state-note is-error"
          data-testid="ws-preset-import-error"
        >
          {importError}
        </p>
      )}

      {saveOpen && (
        <TextPromptDialog
          title="Save Preset"
          fieldLabel="Preset name"
          submitLabel="Save"
          description={
            <p>
              Presets are device-global recipes: mode plus Halftone, Diffusion,
              and Glitch settings. Transforms, plates, and output never enter a
              preset.
            </p>
          }
          onSubmit={(name) => {
            setSaveOpen(false);
            void project.savePreset(name);
          }}
          onCancel={() => setSaveOpen(false)}
        />
      )}
    </section>
  );
}
