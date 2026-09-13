/**
 * Layers panel — the real ordered stack (bottom-to-top in the document,
 * rendered top-most first). Rows select (Shift/Cmd multi-select), toggle
 * visibility and lock, and the toolbar acts on the primary layer: mode,
 * opacity, reorder, duplicate, delete.
 *
 * RENDER SCOPE NOTE (render-binding wave): the canvas currently renders the
 * PRIMARY layer through the legacy single-layer engine; full stack
 * composition arrives with the worker renderer. The stack edits below are
 * already real document commands and fully undoable.
 */

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Id } from "../../core/types";
import { Icon } from "../../components/icons";
import NumericField from "../../studio/NumericField";
import { useProjectUi } from "../project-ui";

const MODES = [
  { id: "clean", label: "Clean" },
  { id: "halftone", label: "Halftone" },
  { id: "diffusion", label: "Diffusion" },
] as const;

export function LayersPanel() {
  const project = useProjectUi();
  const [renamingId, setRenamingId] = useState<Id | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  const layers = [...project.layers].reverse(); // top-most first
  const primary = project.layers.find((layer) => layer.id === project.primaryLayerId) ?? null;
  const recipeTargets = project.selectedLayerIds.filter((id) => {
    if (id === project.primaryLayerId) return false;
    const layer = project.layers.find((candidate) => candidate.id === id);
    return Boolean(layer && !layer.locked);
  });

  function commitRename() {
    if (renamingId && renameValue.trim()) {
      project.renameLayer(renamingId, renameValue);
    }
    setRenamingId(null);
  }

  function beginRename(layer: { id: Id; name: string }) {
    setRenamingId(layer.id);
    setRenameValue(layer.name);
  }

  /**
   * Selection buttons: ArrowUp/ArrowDown move focus and selection
   * through the visual (top-most-first) order, Shift+Arrow extends it,
   * Home/End jump, F2 renames the primary row, Space toggles the
   * row in the selection.
   */
  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (renamingId !== null || !(event.target instanceof HTMLElement) ||
        !event.target.closest("[data-layer-select]")) return;
    const currentIndex = layers.findIndex(
      (layer) => layer.id === project.primaryLayerId,
    );
    const moveTo = (index: number, additive: boolean) => {
      const target = layers[Math.max(0, Math.min(layers.length - 1, index))];
      if (target) {
        project.selectLayer(target.id, { additive });
        Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-layer-select]") ?? [])
          .find((button) => button.dataset.layerSelect === target.id)?.focus();
      }
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTo(currentIndex + 1, event.shiftKey);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(currentIndex - 1, event.shiftKey);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTo(0, false);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTo(layers.length - 1, false);
    } else if (event.key === "F2" && primary) {
      event.preventDefault();
      beginRename(primary);
    } else if (event.key === " " && primary) {
      event.preventDefault();
      project.selectLayer(primary.id, { additive: true });
    }
  }

  return (
    <div className="ws-panel-stack">
      <div className="ws-layer-toolbar" role="group" aria-label="Layer actions">
        <button
          type="button"
          onClick={project.addLayerFromFile}
          title="Import artwork as a NEW layer — existing layers and artboard are preserved"
        >
          Add Layer
        </button>
        <button
          type="button"
          disabled={!primary}
          onClick={() => primary && project.duplicateLayer(primary.id)}
        >
          Duplicate Layer
        </button>
        <button
          type="button"
          disabled={!primary}
          onClick={() => primary && project.moveLayer(primary.id, "up")}
        >
          Move Layer Up
        </button>
        <button
          type="button"
          disabled={!primary}
          onClick={() => primary && project.moveLayer(primary.id, "down")}
        >
          Move Layer Down
        </button>
        <button
          type="button"
          disabled={!primary}
          onClick={() => primary && project.removeLayer(primary.id)}
        >
          Delete Layer
        </button>
        <button
          type="button"
          disabled={recipeTargets.length === 0}
          title={
            recipeTargets.length === 0
              ? "Select additional unlocked layers to receive the primary layer's recipe"
              : "Apply the primary layer's full recipe to the selected unlocked layers (one undo step)"
          }
          onClick={project.applyRecipeToSelected}
        >
          Apply Recipe to Selected
        </button>
      </div>

      {layers.length === 0 ? (
        <p className="control-state-note">
          No layers yet. Import artwork to create layer 1 — recipes,
          transforms, and plates all act on layers.
        </p>
      ) : (
        <ul
          className="ws-layer-list"
          data-testid="ws-layer-list"
          aria-label="Layers"
          ref={listRef}
          onKeyDown={onListKeyDown}
        >
          {layers.map((layer) => {
            const selected = project.selectedLayerIds.includes(layer.id);
            const isPrimary = layer.id === project.primaryLayerId;
            return (
              <li
                key={layer.id}
                className={`ws-layer-row ${selected || isPrimary ? "is-selected" : ""}`}
                data-testid="ws-layer-row"
              >
                {renamingId === layer.id ? (
                  <input
                    autoFocus
                    aria-label={`Rename ${layer.name}`}
                    value={renameValue}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="ws-layer-select"
                    data-layer-select={layer.id}
                    aria-label={`Select ${layer.name}`}
                    aria-pressed={selected || isPrimary}
                    aria-current={isPrimary ? "true" : undefined}
                    onClick={(event) => project.selectLayer(layer.id, {
                      additive: event.shiftKey || event.metaKey || event.ctrlKey,
                    })}
                    onDoubleClick={() => beginRename(layer)}
                  >
                    <span className="ws-layer-thumb" aria-hidden="true"><Icon name="file-image" size={15} /></span>
                    <span className="ws-layer-name">{layer.name}</span>
                  </button>
                )}
                <span className="ws-layer-controls">
                  {/* Selector contract: visibility is a CHECKBOX named
                      "<layer> visible" (export-preflight drives it with
                      check/uncheck); the Hide/Show text stays the visual. */}
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={layer.visible}
                    aria-label={`${layer.name} visible`}
                    title={layer.visible ? "Visible — click to hide" : "Hidden — click to show"}
                    onClick={(event) => {
                      event.stopPropagation();
                      project.setLayerVisible(layer.id, !layer.visible);
                    }}
                  >
                    {layer.visible ? "Hide" : "Show"}
                  </button>
                  <button
                    type="button"
                    aria-pressed={layer.locked}
                    aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
                    title={layer.locked ? "Locked — click to unlock" : "Unlocked — click to lock"}
                    onClick={(event) => {
                      event.stopPropagation();
                      project.setLayerLocked(layer.id, !layer.locked);
                    }}
                  >
                    {layer.locked ? "Unlock" : "Lock"}
                  </button>
                  <span className="ws-layer-state">
                    {Math.round(layer.opacity * 100)}%
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {primary && (
        <>
          <fieldset
            className="mode-fieldset"
            role="radiogroup"
            aria-label="Layer mode"
          >
            <legend>Layer mode</legend>
            {MODES.map((mode) => (
              <label key={mode.id} className="ws-layer-mode-option">
                <input
                  type="radio"
                  name="ws-layer-mode"
                  aria-label={mode.label}
                  checked={primary.recipe.mode === mode.id}
                  onChange={() => project.setLayerMode(primary.id, mode.id)}
                />
                {mode.label}
              </label>
            ))}
          </fieldset>
          <NumericField
            id="layerOpacity"
            label="Opacity"
            value={Math.round(primary.opacity * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            defaultValue={100}
            hint="Multiplies the layer's alpha exactly once in the plate stack."
            onChange={(value) => project.setLayerOpacity(primary.id, value / 100)}
          />
        </>
      )}
    </div>
  );
}
