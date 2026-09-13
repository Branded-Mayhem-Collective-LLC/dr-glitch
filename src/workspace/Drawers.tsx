/**
 * Fixed upper-right drawers — Document, Proof, Output/Preflight Summary.
 * They sit permanently above the dock's tool panel; at most one is expanded
 * and its content scrolls independently of the panel below.
 *
 * The Document drawer owns artboard preset/custom size, px/in/mm display,
 * fixed 240 DPI, proof background, rulers, grid, guides, and snapping —
 * the full workspace contract. Custom sizes validate through
 * validateArtboardSize (integer px at 240 DPI, ResourcePolicy pixel budget
 * surfaced verbatim).
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { DOCUMENT_DPI, SHEET_SIZES, type SheetSizeId } from "../studio/document-model";
import { PLATES, PLATE_META } from "../studio/halftone";
import NumericField from "../studio/NumericField";
import { pxToUnit } from "../editor";
import { resolveRegistration } from "../export/targets";
import type { RegistrationLayout } from "./studio-api";
import { describeTarget } from "../export/targets";
import { validateArtboardSize } from "./canvas/artboard-size";
import { buildTargetFromSession } from "./export-target";
import { useProjectUi } from "./project-ui";
import { useStudioApi, type UnitDisplay } from "./studio-api";
import { useWorkspaceController } from "./workspace-controller";
import type { DrawerId } from "./layout-state";

/**
 * `ariaLabel` is the binding accessible name from the e2e selector contract
 * (tests/e2e/helpers/workstation.ts); `label` is the visible heading.
 */
const DRAWERS: Array<{ id: DrawerId; label: string; ariaLabel: string }> = [
  { id: "document", label: "Document", ariaLabel: "Document" },
  { id: "proof", label: "Proof", ariaLabel: "Proof" },
  { id: "output", label: "Output / Preflight Summary", ariaLabel: "Output" },
];

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatDimension(px: number, unit: UnitDisplay): string {
  if (unit === "px") return `${px}px`;
  if (unit === "in") return `${(px / DOCUMENT_DPI).toFixed(2)}in`;
  return `${((px / DOCUMENT_DPI) * 25.4).toFixed(1)}mm`;
}

export function Drawers({ expanded }: { expanded: DrawerId | null }) {
  const controller = useWorkspaceController();

  return (
    <div className="ws-drawers" data-testid="ws-drawers">
      {DRAWERS.map((drawer) => {
        const isExpanded = expanded === drawer.id;
        return (
          <section key={drawer.id} className="ws-drawer">
            <h2 className="ws-drawer-heading">
              <button
                type="button"
                className="ws-drawer-toggle"
                aria-expanded={isExpanded}
                aria-controls={`ws-drawer-${drawer.id}`}
                aria-label={drawer.ariaLabel}
                data-testid={`ws-drawer-toggle-${drawer.id}`}
                onClick={() =>
                  controller.setExpandedDrawer(isExpanded ? null : drawer.id)
                }
              >
                <span>{drawer.label}</span>
                <span className="ws-drawer-state" aria-hidden="true">
                  {isExpanded ? "−" : "+"}
                </span>
              </button>
            </h2>
            {isExpanded && (
              <div
                className="ws-drawer-body"
                id={`ws-drawer-${drawer.id}`}
                data-testid={`ws-drawer-${drawer.id}`}
                role="region"
                aria-label={drawer.ariaLabel}
              >
                {drawer.id === "document" && <DocumentDrawer />}
                {drawer.id === "proof" && <ProofDrawer />}
                {drawer.id === "output" && <OutputDrawer />}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function DocumentDrawer() {
  const api = useStudioApi();
  const project = useProjectUi();
  const { documentSettings, outputDimensions, unitDisplay } = api;

  return (
    <div className="ws-drawer-stack">
      <label className="select-field">
        <span>Sheet size</span>
        <select
          data-testid="artwork-sheet-size"
          value={documentSettings.sheetSize}
          onChange={(event) =>
            api.updateDocument({ sheetSize: event.target.value as SheetSizeId })
          }
        >
          {SHEET_SIZES.map((sheet) => (
            <option key={sheet.id} value={sheet.id}>
              {sheet.label}
            </option>
          ))}
        </select>
      </label>

      <div className="artwork-control-group">
        <span className="artwork-control-label">Orientation</span>
        <div className="segmented-control" role="group" aria-label="Orientation">
          {(["portrait", "landscape"] as const).map((orientation) => (
            <button
              key={orientation}
              type="button"
              data-testid={`artwork-orientation-${orientation}`}
              aria-pressed={documentSettings.orientation === orientation}
              onClick={() => api.updateDocument({ orientation })}
            >
              {titleCase(orientation)}
            </button>
          ))}
        </div>
      </div>

      <div className="artwork-control-group">
        <span className="artwork-control-label">Display units</span>
        <div className="segmented-control" role="group" aria-label="Display units">
          {(["px", "in", "mm"] as const).map((unit) => (
            <button
              key={unit}
              type="button"
              aria-pressed={unitDisplay === unit}
              onClick={() => api.setUnitDisplay(unit)}
            >
              {unit}
            </button>
          ))}
        </div>
      </div>

      <p className="ws-drawer-fact" data-testid="document-dimensions">
        {formatDimension(outputDimensions.width, unitDisplay)} ×{" "}
        {formatDimension(outputDimensions.height, unitDisplay)} · fixed{" "}
        {DOCUMENT_DPI} DPI
      </p>

      <div className="artwork-control-group">
        <span className="artwork-control-label">Artboard background</span>
        <div className="segmented-control" role="group" aria-label="Background">
          {(["white", "black", "transparent"] as const).map((background) => (
            <button
              key={background}
              type="button"
              data-testid={`artwork-background-${background}`}
              aria-pressed={project.core.artboard.background === background}
              onClick={() =>
                project.applyCommands(
                  { type: "artboard/set-background", background },
                  "Background",
                )
              }
            >
              {titleCase(background)}
            </button>
          ))}
        </div>
        <p className="control-state-note">
          Proof paper and optional composite matte only — never plate ink.
          Transparent keeps real alpha in the proof and in PNG/TIFF exports.
        </p>
      </div>

      <CustomSizeEditor />

      <fieldset className="mode-fieldset">
        <label className="toggle-row">
          <span>
            <strong>Rulers</strong>
            <small>Unit-aware rulers along the canvas; drag out guides.</small>
          </span>
          <input
            type="checkbox"
            data-testid="document-rulers-toggle"
            checked={project.rulersVisible}
            onChange={(event) => project.setRulersVisible(event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Grid</strong>
          </span>
          <input
            type="checkbox"
            data-testid="document-grid-toggle"
            checked={project.core.grid.visible}
            onChange={(event) => project.updateGrid({ visible: event.target.checked })}
          />
        </label>
        <NumericField
          id="gridSize"
          label="Grid size"
          value={project.core.grid.size}
          min={4}
          max={1024}
          step={1}
          unit="px"
          showSlider={false}
          hint="Grid spacing in document pixels."
          onChange={(size) => project.updateGrid({ size })}
        />
        <label className="toggle-row">
          <span>
            <strong>Guides</strong>
          </span>
          <input
            type="checkbox"
            checked={project.core.guides.visible}
            onChange={(event) => project.setGuidesVisible(event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Lock guides</strong>
          </span>
          <input
            type="checkbox"
            data-testid="document-guides-lock"
            checked={project.core.guides.locked}
            onChange={(event) => project.setGuidesLocked(event.target.checked)}
          />
        </label>
        {/* Keyboard guide creation: guides spawn at the artboard center and
            are then arrow-key nudged on their focusable guide element (the
            pointer alternative is dragging out of a ruler). Undoable. */}
        <div className="artwork-action-row">
          <button
            type="button"
            data-testid="document-add-guide-vertical"
            disabled={project.core.guides.locked}
            title="Add a vertical guide at the artboard center (arrow keys move it)"
            onClick={() =>
              project.applyCommands(
                {
                  type: "guides/add",
                  axis: "vertical",
                  offset: Math.round(project.core.artboard.widthPx / 2),
                },
                "Add guide",
              )
            }
          >
            Add Vertical Guide
          </button>
          <button
            type="button"
            data-testid="document-add-guide-horizontal"
            disabled={project.core.guides.locked}
            title="Add a horizontal guide at the artboard center (arrow keys move it)"
            onClick={() =>
              project.applyCommands(
                {
                  type: "guides/add",
                  axis: "horizontal",
                  offset: Math.round(project.core.artboard.heightPx / 2),
                },
                "Add guide",
              )
            }
          >
            Add Horizontal Guide
          </button>
        </div>
        <button
          type="button"
          className="button secondary"
          data-testid="document-clear-guides"
          disabled={
            project.core.guides.horizontal.length === 0 &&
            project.core.guides.vertical.length === 0
          }
          onClick={project.clearGuides}
        >
          Clear Guides
        </button>
      </fieldset>

      <fieldset className="mode-fieldset">
        <label className="toggle-row">
          <span>
            <strong>Snapping</strong>
          </span>
          <input
            type="checkbox"
            checked={project.core.snapping.enabled}
            onChange={(event) => project.updateSnapping({ enabled: event.target.checked })}
          />
        </label>
        {(
          [
            ["toGuides", "Snap to guides"],
            ["toGrid", "Snap to grid"],
            ["toLayers", "Snap to layers"],
            ["toArtboard", "Snap to artboard"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="toggle-row">
            <span>{label}</span>
            <input
              type="checkbox"
              data-testid={`document-snap-${key}`}
              disabled={!project.core.snapping.enabled}
              checked={project.core.snapping[key]}
              onChange={(event) =>
                project.updateSnapping({ [key]: event.target.checked })
              }
            />
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** Formats a px dimension for editing in the current display unit. */
function dimensionInputValue(px: number, unit: UnitDisplay): string {
  if (unit === "px") return String(px);
  return String(Math.round(pxToUnit(px, unit) * 1000) / 1000);
}

function CustomSizeEditor() {
  const api = useStudioApi();
  const project = useProjectUi();
  const { outputDimensions, unitDisplay } = api;
  const [width, setWidth] = useState(() => dimensionInputValue(outputDimensions.width, unitDisplay));
  const [height, setHeight] = useState(() => dimensionInputValue(outputDimensions.height, unitDisplay));
  const [error, setError] = useState<string | null>(null);

  // Track document/unit changes while the user is not mid-edit.
  useEffect(() => {
    setWidth(dimensionInputValue(outputDimensions.width, unitDisplay));
    setHeight(dimensionInputValue(outputDimensions.height, unitDisplay));
    setError(null);
  }, [outputDimensions.width, outputDimensions.height, unitDisplay]);

  function applySize() {
    const result = validateArtboardSize(width, height, unitDisplay);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    if (
      result.widthPx === outputDimensions.width &&
      result.heightPx === outputDimensions.height
    ) {
      return;
    }
    project.resizeArtboard(result.widthPx, result.heightPx);
  }

  /*
   * Standard inline-field error pattern (workstation-wide): when a field is
   * invalid, it carries aria-invalid AND aria-describedby pointing at the
   * visible role="alert" error text, so the failure is announced against
   * the field itself, not only somewhere on the page.
   */
  const errorId = "artboard-custom-error";

  return (
    <div className="artwork-control-group">
      <span className="artwork-control-label">Custom size ({unitDisplay})</span>
      <div className="ws-custom-size-row">
        <label>
          <span className="visually-hidden">Artboard width in {unitDisplay}</span>
          <input
            type="text"
            inputMode="decimal"
            data-testid="artboard-custom-width"
            aria-label={`Artboard width (${unitDisplay})`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={width}
            onChange={(event) => setWidth(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applySize();
            }}
          />
        </label>
        <span aria-hidden="true">×</span>
        <label>
          <span className="visually-hidden">Artboard height in {unitDisplay}</span>
          <input
            type="text"
            inputMode="decimal"
            data-testid="artboard-custom-height"
            aria-label={`Artboard height (${unitDisplay})`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={height}
            onChange={(event) => setHeight(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applySize();
            }}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          data-testid="artboard-custom-apply"
          onClick={applySize}
        >
          Apply
        </button>
      </div>
      {error && (
        <p
          id={errorId}
          className="control-state-note is-error"
          data-testid="artboard-custom-error"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function ProofDrawer() {
  const api = useStudioApi();
  const { settings, activePlate, zoomBounds } = api;

  return (
    <div className="ws-drawer-stack">
      <label className="select-field">
        <span>Proof plate</span>
        <select
          data-testid="proof-view-select"
          aria-label="Proof plate"
          value={activePlate}
          onChange={(event) =>
            api.soloPlate(event.target.value as typeof activePlate)
          }
        >
          <option value="composite">
            {settings.grayscale ? "Grayscale proof (K)" : "Composite"}
          </option>
          {api.applicablePlates.map((plate) => (
            <option key={plate} value={plate}>
              {PLATE_META[plate].label} plate
            </option>
          ))}
        </select>
      </label>

      <div className="artwork-control-group">
        <span className="artwork-control-label">Plate visibility</span>
        {PLATES.map((plate) => {
          const disabled = Boolean(settings.grayscale && plate !== "black");
          return (
            <label key={plate} className="toggle-row">
              <span>
                <strong>{PLATE_META[plate].label}</strong>
              </span>
              <input
                type="checkbox"
                data-testid={`proof-visible-${plate}`}
                disabled={disabled}
                checked={settings.visible[plate]}
                onChange={() => api.togglePlateVisible(plate)}
              />
            </label>
          );
        })}
      </div>

      <div className="artwork-control-group">
        <NumericField
          id="zoom"
          label="Zoom"
          value={api.zoom}
          min={zoomBounds.min}
          max={zoomBounds.max}
          step={1}
          unit="%"
          defaultValue={zoomBounds.fit}
          showSlider={false}
          hint="Changes only the proof view, never the exported artwork."
          onChange={api.setZoom}
        />
        <div className="segmented-control" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() =>
              api.setZoom(Math.max(zoomBounds.min, api.zoom - 8))
            }
          >
            −
          </button>
          <button type="button" onClick={() => api.setZoom(zoomBounds.fit)}>
            Fit
          </button>
          <button
            type="button"
            onClick={() => api.setZoom(Math.min(zoomBounds.max, 100))}
          >
            100%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() =>
              api.setZoom(Math.min(zoomBounds.max, api.zoom + 8))
            }
          >
            +
          </button>
        </div>
      </div>

      <label className="toggle-row">
        <span>
          <strong>Registration overlay</strong>
          <small>
            Show registration marks on the live proof. View-only for this
            session — the exported output follows the Output drawer defaults.
          </small>
        </span>
        <input
          type="checkbox"
          data-testid="proof-registration-overlay"
          checked={api.proofRegistration}
          onChange={(event) => api.setProofRegistration(event.target.checked)}
        />
      </label>
    </div>
  );
}

/**
 * Output drawer — canonical output ownership (P0 prepress contract).
 * Binds directly and UNDOABLY to core.output (polarity / pressMirror /
 * registrationOnPlates / registrationOnComposite) via output/update; it
 * never edits layer recipes or transforms. Readiness comes from the ACTIVE
 * export target's preflight evaluate().
 */
function OutputDrawer() {
  const api = useStudioApi();
  const project = useProjectUi();
  const controller = useWorkspaceController();
  const output = project.core.output;

  const session = api.exportSession;
  const sessionState = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getState(),
  );
  const target = buildTargetFromSession(sessionState, {
    selectedLayerId: api.exportPipeline.selectedLayerId,
    vectorEligible: api.exportPipeline.vectorEligibility().eligible,
  });
  const registrationEnabled = output.registrationOnPlates || output.registrationOnComposite ||
    (target !== null && resolveRegistration(target, output));
  const issues = target ? api.exportPipeline.evaluate(target) : [];
  const blockCount = issues.filter((issue) => issue.severity === "block").length;
  const warnCount = issues.filter((issue) => issue.severity === "warn").length;
  const readiness = !target
    ? "No export target available — import artwork first."
    : blockCount > 0
      ? `Blocked: ${blockCount} preflight ${blockCount === 1 ? "issue" : "issues"} for ${describeTarget(target)}.`
      : warnCount > 0
        ? `${warnCount} preflight ${warnCount === 1 ? "item" : "items"} to review for ${describeTarget(target)}.`
        : `Press-ready: no findings for ${describeTarget(target)}.`;

  return (
    <div className="ws-drawer-stack">
      <label className="select-field">
        <span>Dot polarity</span>
        <select
          data-testid="output-polarity"
          value={output.polarity}
          onChange={(event) =>
            api.updateOutput({
              polarity: event.target.value === "negative" ? "negative" : "positive",
            })
          }
        >
          <option value="positive">Standard positive</option>
          <option value="negative">Negative (inverted at output)</option>
        </select>
      </label>

      <label className="toggle-row">
        <span>
          <strong>Press mirror</strong>
          <small>Mirror the finished output for film or screen positives.</small>
        </span>
        <input
          type="checkbox"
          data-testid="output-press-mirror"
          checked={output.pressMirror}
          onChange={(event) => api.updateOutput({ pressMirror: event.target.checked })}
        />
      </label>

      <label className="toggle-row">
        <span>
          <strong>Registration on plate packages</strong>
          <small>Default for plate-package exports; overridable per export.</small>
        </span>
        <input
          type="checkbox"
          data-testid="output-registration-default"
          checked={output.registrationOnPlates}
          onChange={(event) =>
            api.updateOutput({ registrationOnPlates: event.target.checked })
          }
        />
      </label>

      <label className="toggle-row">
        <span>
          <strong>Registration on composite</strong>
          <small>Default for composite exports; overridable per export.</small>
        </span>
        <input
          type="checkbox"
          data-testid="output-registration-composite"
          checked={output.registrationOnComposite}
          onChange={(event) =>
            api.updateOutput({ registrationOnComposite: event.target.checked })
          }
        />
      </label>

      <label className="select-field">
        <span>Registration layout</span>
        <select
          value={api.registrationMode}
          disabled={!registrationEnabled}
          onChange={(event) =>
            api.setRegistrationMode(event.target.value as RegistrationLayout)
          }
        >
          <option value="corners">Four corners</option>
          <option value="centered">Top / bottom centered</option>
        </select>
      </label>
      <NumericField
        id="registrationSize"
        label="Registration size"
        value={api.registrationSize}
        min={20}
        max={600}
        step={1}
        unit="px"
        defaultValue={120}
        disabled={!registrationEnabled}
        onChange={api.setRegistrationSize}
      />
      <NumericField
        id="registrationOffset"
        label="Registration offset"
        value={api.registrationOffset}
        min={10}
        max={1000}
        step={1}
        unit="px"
        defaultValue={120}
        disabled={!registrationEnabled}
        onChange={api.setRegistrationOffset}
      />
      <NumericField
        id="registrationWeight"
        label="Registration weight"
        value={api.registrationWeight}
        min={1}
        max={20}
        step={0.5}
        unit="px"
        defaultValue={2}
        disabled={!registrationEnabled}
        onChange={api.setRegistrationWeight}
      />
      <div className="registration-import-row">
        <button
          type="button"
          className="button secondary"
          onClick={api.requestRegistrationFile}
        >
          {api.registrationShape
            ? "Replace registration SVG"
            : "Import registration SVG"}
        </button>
        {api.registrationShape && <span>{api.registrationShape.filename}</span>}
      </div>

      <p className="ws-drawer-fact" data-testid="output-readiness">
        {readiness}
      </p>

      <button
        type="button"
        className="button secondary"
        data-testid="output-open-export"
        onClick={() => controller.activateTool("export")}
      >
        Open export workflow
      </button>
    </div>
  );
}
