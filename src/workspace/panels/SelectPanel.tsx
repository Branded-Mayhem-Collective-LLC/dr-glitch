/**
 * Select / Transform panel — artwork source, numeric transform fields for
 * the primary layer (position/scale/rotation), legacy sheet placement
 * (scale %, fit, mirror), alignment/distribution over the selection or
 * artboard, and the on-canvas Crop / Perspective editing modes.
 *
 * All document edits dispatch canonical commands through
 * project.applyCommands (one undo transaction each); alignment math is the
 * pure editor module (alignToSelection / alignBounds / distributeBounds).
 */

import { useState } from "react";
import { Icon } from "../../components/icons";
import { DEFAULT_DOCUMENT_SETTINGS } from "../../studio/document-model";
import NumericField from "../../studio/NumericField";
import {
  alignBounds,
  alignToSelection,
  croppedSize,
  distributeBounds,
  transformedBounds,
  type AlignItem,
  type AlignMode,
  type DistributeAxis,
} from "../../editor";
import { clearCropCommands } from "../canvas/crop-drag";
import { composeTransformPatch, translateQuad } from "../canvas/transform-compose";
import type { Command } from "../../project";
import type { TransformPatch } from "../../project/commands";
import { useProjectUi } from "../project-ui";
import { useStudioApi } from "../studio-api";

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

const ALIGN_MODES: Array<{ mode: AlignMode; label: string }> = [
  { mode: "left", label: "Align left" },
  { mode: "centerX", label: "Align horizontal centers" },
  { mode: "right", label: "Align right" },
  { mode: "top", label: "Align top" },
  { mode: "centerY", label: "Align vertical centers" },
  { mode: "bottom", label: "Align bottom" },
];

export function SelectPanel() {
  const api = useStudioApi();
  const project = useProjectUi();
  const { documentSettings } = api;
  const [alignTo, setAlignTo] = useState<"selection" | "artboard">("selection");
  const primary =
    project.layers.find((layer) => layer.id === project.primaryLayerId) ?? null;
  const primaryAsset = primary ? project.assetSizeFor(primary.id) : null;
  const positionLimit = Math.max(project.core.artboard.widthPx, project.core.artboard.heightPx);

  /** Selected, unlocked layers with known sizes as alignment items. */
  function alignItems(): AlignItem[] {
    const items: AlignItem[] = [];
    for (const id of project.selectedLayerIds) {
      const layer = project.layers.find((candidate) => candidate.id === id);
      if (!layer || layer.locked) continue;
      const asset = project.assetSizeFor(id);
      if (!asset) continue;
      items.push({
        id,
        bounds: transformedBounds(
          layer.transform,
          croppedSize(layer.crop, asset.width, asset.height),
        ),
      });
    }
    return items;
  }

  function applyDeltas(deltas: { id: string; delta: { x: number; y: number } }[], label: string) {
    const entries: Extract<Command, { type: "layers/set-transforms" }>["entries"] = [];
    for (const { id, delta } of deltas) {
      if (delta.x === 0 && delta.y === 0) continue;
      const layer = project.layers.find((candidate) => candidate.id === id);
      if (!layer) continue;
      entries.push({
        layerId: id,
        transform: {
          ...layer.transform,
          position: {
            x: layer.transform.position.x + delta.x,
            y: layer.transform.position.y + delta.y,
          },
          // A perspective quad IS the rendered geometry; it travels with
          // the alignment translation (composition, not replacement).
          perspective: layer.transform.perspective
            ? translateQuad(layer.transform.perspective, delta.x, delta.y)
            : null,
        },
      });
    }
    if (entries.length > 0) {
      project.applyCommands({ type: "layers/set-transforms", entries }, label);
    }
  }

  function align(mode: AlignMode) {
    const items = alignItems();
    if (items.length === 0) return;
    const deltas =
      alignTo === "artboard"
        ? alignBounds(items, mode, {
            x: 0,
            y: 0,
            width: project.core.artboard.widthPx,
            height: project.core.artboard.heightPx,
          })
        : alignToSelection(items, mode);
    applyDeltas(deltas, "Align layers");
  }

  function distribute(axis: DistributeAxis) {
    const items = alignItems();
    const deltas = distributeBounds(
      items,
      axis,
      alignTo === "artboard"
        ? {
            x: 0,
            y: 0,
            width: project.core.artboard.widthPx,
            height: project.core.artboard.heightPx,
          }
        : null,
    );
    applyDeltas(deltas, "Distribute layers");
  }

  /**
   * One undoable affine patch against the primary layer. On a
   * perspective-carrying layer the quad is mapped through the delta affine
   * (composeTransformPatch) so numerics stay VISIBLY effective after a
   * warp is applied.
   */
  function patchPrimary(patch: TransformPatch, label: string) {
    if (!primary) return;
    project.applyCommands(
      {
        type: "layer/set-transform",
        layerId: primary.id,
        patch: composeTransformPatch(primary.transform, patch),
      },
      label,
    );
  }

  const cropActive = project.editorMode === "crop";
  const perspectiveActive = project.editorMode === "perspective";

  return (
    <div className="ws-panel-stack">
      <button className="upload-card" onClick={api.requestArtworkFile}>
        <span className="upload-icon">
          <Icon name="image-add" size={20} />
        </span>
        <span>
          <strong>{api.sourceName}</strong>
          <small>{api.sourceMeta}</small>
        </span>
        <span className="replace-label">Replace</span>
      </button>

      {primary && (
        <div className="field-grid" aria-label="Layer position">
          <NumericField
            id="transformX"
            label="Position X"
            value={Math.round(primary.transform.position.x)}
            min={-positionLimit}
            max={positionLimit * 2}
            step={1}
            unit="px"
            showSlider={false}
            hint="Layer anchor X in document pixels; screens never move with artwork."
            onChange={(value) =>
              patchPrimary(
                { position: { ...primary.transform.position, x: value } },
                "Move layer",
              )
            }
          />
          <NumericField
            id="transformY"
            label="Position Y"
            value={Math.round(primary.transform.position.y)}
            min={-positionLimit}
            max={positionLimit * 2}
            step={1}
            unit="px"
            showSlider={false}
            onChange={(value) =>
              patchPrimary(
                { position: { ...primary.transform.position, y: value } },
                "Move layer",
              )
            }
          />
          <NumericField
            id="transformScaleX"
            label="Scale X"
            value={Math.round(primary.transform.scale.x * 100)}
            min={1}
            max={1000}
            step={1}
            unit="%"
            defaultValue={100}
            showSlider={false}
            onChange={(value) =>
              patchPrimary(
                { scale: { ...primary.transform.scale, x: value / 100 } },
                "Scale layer",
              )
            }
          />
          <NumericField
            id="transformScaleY"
            label="Scale Y"
            value={Math.round(primary.transform.scale.y * 100)}
            min={1}
            max={1000}
            step={1}
            unit="%"
            defaultValue={100}
            showSlider={false}
            onChange={(value) =>
              patchPrimary(
                { scale: { ...primary.transform.scale, y: value / 100 } },
                "Scale layer",
              )
            }
          />
          <NumericField
            id="transformRotation"
            label="Rotation"
            value={Math.round(primary.transform.rotation)}
            min={-360}
            max={360}
            step={1}
            unit="°"
            defaultValue={0}
            showSlider={false}
            onChange={(value) => patchPrimary({ rotation: value }, "Rotate layer")}
          />
          <NumericField
            id="transformSkewX"
            label="Skew X"
            value={Math.round(primary.transform.skew.x)}
            min={-85}
            max={85}
            step={1}
            unit="°"
            defaultValue={0}
            showSlider={false}
            hint="Horizontal shear in degrees; composes with scale and rotation."
            onChange={(value) =>
              patchPrimary(
                { skew: { ...primary.transform.skew, x: value } },
                "Skew layer",
              )
            }
          />
          <NumericField
            id="transformSkewY"
            label="Skew Y"
            value={Math.round(primary.transform.skew.y)}
            min={-85}
            max={85}
            step={1}
            unit="°"
            defaultValue={0}
            showSlider={false}
            onChange={(value) =>
              patchPrimary(
                { skew: { ...primary.transform.skew, y: value } },
                "Skew layer",
              )
            }
          />
        </div>
      )}

      {primary && (
        <div className="artwork-control-group" aria-label="Layer flip">
          <span className="artwork-control-label">Flip layer</span>
          <div className="segmented-control" role="group" aria-label="Flip layer">
            <button
              type="button"
              data-testid="select-flip-h"
              aria-pressed={primary.transform.flipH}
              disabled={primary.locked}
              title="Flip the layer horizontally (independent of Flip V)"
              onClick={() =>
                patchPrimary({ flipH: !primary.transform.flipH }, "Flip layer")
              }
            >
              Flip H
            </button>
            <button
              type="button"
              data-testid="select-flip-v"
              aria-pressed={primary.transform.flipV}
              disabled={primary.locked}
              title="Flip the layer vertically (independent of Flip H)"
              onClick={() =>
                patchPrimary({ flipV: !primary.transform.flipV }, "Flip layer")
              }
            >
              Flip V
            </button>
          </div>
        </div>
      )}

      {primary && (
        <div className="artwork-control-group" aria-label="Editing mode">
          <span className="artwork-control-label">On-canvas editing</span>
          <div className="segmented-control" role="group" aria-label="Editing mode">
            <button
              type="button"
              data-testid="select-crop-toggle"
              aria-pressed={cropActive}
              disabled={!primaryAsset || primary.locked}
              title={
                primaryAsset
                  ? "Edit the non-destructive crop on the canvas"
                  : "The layer source is still decoding"
              }
              onClick={() => project.setEditorMode(cropActive ? "transform" : "crop")}
            >
              Crop
            </button>
            <button
              type="button"
              data-testid="select-perspective-toggle"
              aria-pressed={perspectiveActive}
              disabled={!primaryAsset || primary.locked}
              onClick={() =>
                project.setEditorMode(perspectiveActive ? "transform" : "perspective")
              }
            >
              Perspective
            </button>
          </div>
          <div className="artwork-action-row">
            {primary.crop !== null && primaryAsset && (
              <button
                type="button"
                data-testid="select-clear-crop"
                onClick={() =>
                  project.applyCommands(clearCropCommands(primary, primaryAsset), "Clear crop")
                }
              >
                Clear Crop
              </button>
            )}
            {primary.transform.perspective !== null && (
              <button
                type="button"
                data-testid="select-reset-perspective"
                onClick={() =>
                  project.applyCommands(
                    {
                      type: "layer/set-transform",
                      layerId: primary.id,
                      patch: { perspective: null },
                    },
                    "Reset perspective",
                  )
                }
              >
                Reset Perspective
              </button>
            )}
          </div>
          {cropActive && (
            <p className="control-state-note">
              Drag the crop handles on the canvas. Crop is non-destructive —
              re-entering Crop always shows the full source. Escape cancels a
              drag.
            </p>
          )}
          {perspectiveActive && (
            <p className="control-state-note">
              Drag the four corners on the canvas. Invalid (concave or
              crossed) shapes are refused and keep the last valid corners.
            </p>
          )}
        </div>
      )}

      <div className="artwork-control-group" aria-label="Alignment">
        <span className="artwork-control-label">Align &amp; distribute</span>
        <div className="segmented-control" role="group" aria-label="Alignment reference">
          {(["selection", "artboard"] as const).map((reference) => (
            <button
              key={reference}
              type="button"
              aria-pressed={alignTo === reference}
              onClick={() => setAlignTo(reference)}
            >
              {titleCase(reference)}
            </button>
          ))}
        </div>
        <div className="ws-align-grid" role="group" aria-label="Align">
          {ALIGN_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              className="button secondary"
              data-testid={`select-align-${mode}`}
              aria-label={label}
              title={label}
              onClick={() => align(mode)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="button secondary"
            data-testid="select-distribute-horizontal"
            aria-label="Distribute horizontally"
            title="Distribute horizontally"
            onClick={() => distribute("horizontal")}
          >
            Distribute horizontally
          </button>
          <button
            type="button"
            className="button secondary"
            data-testid="select-distribute-vertical"
            aria-label="Distribute vertically"
            title="Distribute vertically"
            onClick={() => distribute("vertical")}
          >
            Distribute vertically
          </button>
        </div>
      </div>

      <div className="artwork-layout-controls">
        <NumericField
          id="artworkScale"
          label="Scale"
          value={documentSettings.scalePercent}
          min={10}
          max={400}
          step={1}
          unit="%"
          defaultValue={DEFAULT_DOCUMENT_SETTINGS.scalePercent}
          onChange={(scalePercent) => api.updateDocument({ scalePercent })}
        />

        <div className="artwork-action-row">
          <button
            type="button"
            data-testid="artwork-fit"
            onClick={api.fitArtworkToSheet}
          >
            Fit
          </button>
        </div>

        <label className="artwork-mirror-toggle">
          <span>Mirror artwork</span>
          <input
            type="checkbox"
            data-testid="artwork-mirror"
            checked={documentSettings.mirrorImage}
            onChange={(event) =>
              api.updateDocument({ mirrorImage: event.target.checked })
            }
          />
        </label>

        <div className="artwork-control-group">
          <span className="artwork-control-label">Mirror direction</span>
          <div
            className="segmented-control"
            role="group"
            aria-label="Mirror direction"
          >
            {(["horizontal", "vertical"] as const).map((mirrorDirection) => (
              <button
                key={mirrorDirection}
                type="button"
                data-testid={`artwork-mirror-direction-${mirrorDirection}`}
                aria-pressed={
                  documentSettings.mirrorDirection === mirrorDirection
                }
                disabled={!documentSettings.mirrorImage}
                onClick={() => api.updateDocument({ mirrorDirection })}
              >
                {titleCase(mirrorDirection)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="button secondary"
        onClick={api.resetArtwork}
      >
        Reset artwork controls
      </button>
    </div>
  );
}
