/**
 * Preflight / Export panel — the ONE export workflow (the topbar Export
 * button activates this same tool). Output finishing (ink opacity,
 * registration) up top; below it the REAL pipeline:
 *
 * - Quick export menu (topbar-Export contract): the legacy one-click
 *   targets — Composite PNG/JPG/TIFF, Vector SVG plate package, CMYK /
 *   Grayscale K plate package — exported directly with legacy gating
 *   (dense screen load blocks with the legacy toast; hard preflight blocks
 *   toast their reason; warnings do not gate quick exports, matching the
 *   shipped exportArtwork()).
 * - Export target / format radiogroups (selector contract names).
 * - Registration marks checkbox bound to the DOCUMENT defaults per target
 *   (plate packages ↔ output.registrationOnPlates — also the proof's
 *   marks; composite ↔ output.registrationOnComposite; selected layer ↔
 *   session-only choice). An explicit toggle confirms the registration
 *   warnings for the current target.
 * - Live preflight: the legacy five-row summary (data-status review/clear)
 *   plus evaluate() issues (data-severity); hard blocks disable Export Now
 *   with a visible reason; warnings raise "Review warnings".
 * - Progress + explicit Cancel while the orchestrator runs.
 *
 * ALL export workflow state (target choice, run progress/cancel, pending
 * warnings) lives in the session-level ExportSessionStore (StudioApi
 * .exportSession), NOT in panel state: the shell unmounts this panel on
 * tool switches / Focus Mode / placement changes, and a re-mounted panel
 * must bind back into the live run. Duplicate starts are rejected by the
 * store while a run is live.
 */

import { useSyncExternalStore } from "react";
import type { PreflightIssue } from "../../core/types";
import { resolveRegistration, type ExportTarget } from "../../export/targets";
import { MAX_EXPORT_GRID_POINTS, PLATE_META } from "../../studio/halftone";
import { Icon } from "../../components/icons";
import NumericField from "../../studio/NumericField";
import { ChoiceDialog } from "../dialogs";
import { buildTargetFromSession } from "../export-target";
import { useProjectUi } from "../project-ui";
import { useStudioApi } from "../studio-api";

type TargetKind = ExportTarget["kind"];

function PreflightSummaryItem({
  review,
  label,
  value,
}: {
  review: boolean;
  label: string;
  value: string;
}) {
  return (
    <li className={review ? "needs-review" : ""} data-status={review ? "review" : "clear"}>
      <Icon name={review ? "warning" : "check"} size={14} />
      <span>
        <strong>{label}</strong>
        <small>{value}</small>
      </span>
    </li>
  );
}

export function ExportPanel() {
  const api = useStudioApi();
  const project = useProjectUi();
  const { settings, preflight } = api;
  const session = api.exportSession;
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getState(),
  );

  const vector = api.exportPipeline.vectorEligibility();
  const plateFormat = !vector.eligible && state.plateFormat === "svg" ? "png" : state.plateFormat;

  function buildTarget(kind: TargetKind = state.targetKind): ExportTarget | null {
    return buildTargetFromSession(
      state,
      {
        selectedLayerId: api.exportPipeline.selectedLayerId,
        vectorEligible: vector.eligible,
      },
      kind,
    );
  }

  const target = buildTarget();
  const issues = target ? api.exportPipeline.evaluate(target) : [];
  const blocks = issues.filter((issue) => issue.severity === "block");
  const exporting = state.run !== null;
  const registrationChecked =
    state.targetKind === "selected-layer"
      ? state.layerRegistration
      : target
        ? resolveRegistration(target, project.core.output)
        : false;

  function onRegistrationToggle(checked: boolean) {
    if (state.targetKind === "plate-package") {
      api.setRegistrationEnabled(checked);
      session.markRegistrationTouched();
    } else if (state.targetKind === "composite") {
      api.setCompositeRegistration(checked);
      session.markRegistrationTouched();
    } else {
      session.setLayerRegistration(checked);
    }
  }

  function begin(chosen: ExportTarget) {
    session.start(chosen, (chosenTarget, hooks) =>
      api.exportPipeline.start(chosenTarget, hooks),
    );
  }

  function onExportNow() {
    const chosen = buildTarget();
    if (!chosen || exporting) return;
    const freshIssues = api.exportPipeline.evaluate(chosen);
    if (freshIssues.some((issue) => issue.severity === "block")) return;
    // An explicit Registration marks toggle for the CURRENT target IS the
    // confirmation for the registration-default warnings (it resets when
    // the target changes) — no second dialog for the user's own choice.
    const gated = state.registrationTouched
      ? freshIssues.filter(
          (issue) =>
            issue.code !== "registration-on-composite" &&
            issue.code !== "registration-off-plates",
        )
      : freshIssues;
    const unconfirmed = api.exportPipeline.unconfirmedWarnings(gated);
    if (unconfirmed.length > 0) {
      session.setPendingWarnings({ target: chosen, issues: gated });
      return;
    }
    begin(chosen);
  }

  /**
   * Legacy one-click export (topbar Export menu contract): dense screen
   * load blocks with the exact legacy toast; other hard preflight blocks
   * toast their reason; warnings never gate quick exports.
   */
  function quickExport(chosen: ExportTarget) {
    if (session.getState().run !== null) return; // one export at a time
    if (preflight.dense) {
      api.notify(
        `Export blocked: estimated ${preflight.screenLoad.marks.toLocaleString(
          "en-US",
        )} marks per plate exceeds the ${MAX_EXPORT_GRID_POINTS.toLocaleString(
          "en-US",
        )} limit. Increase cell size to export.`,
      );
      return;
    }
    const quickIssues = api.exportPipeline.evaluate(chosen);
    const quickBlocks = quickIssues.filter((issue) => issue.severity === "block");
    if (quickBlocks.length > 0) {
      api.notify(quickBlocks[0].message);
      return;
    }
    begin(chosen);
  }

  const quickTargets: Array<[string, string, ExportTarget]> = [
    ["Composite PNG", "Ready for sharing and proofing", { kind: "composite", format: "png" }],
    [
      "Vector SVG plate package",
      "CMYK or K SVGs in a folder ZIP",
      { kind: "plate-package", format: "svg" },
    ],
    ["Composite JPG", "Flattened JPEG proof", { kind: "composite", format: "jpeg" }],
    ["Composite TIFF", "Uncompressed RGBA TIFF proof", { kind: "composite", format: "tiff" }],
    [
      settings.grayscale ? "Grayscale K plate package" : "CMYK plate package",
      settings.grayscale
        ? "One monochrome K PNG plate + settings"
        : "Four monochrome PNG plates + settings",
      { kind: "plate-package", format: "png" },
    ],
  ];

  const summaryValueScreenLoad = preflight.screenLoad.plate
    ? `${preflight.screenLoad.marks.toLocaleString("en-US")} estimated marks/plate (${
        PLATE_META[preflight.screenLoad.plate].short
      } at ${settings.angles[preflight.screenLoad.plate]}°)`
    : "No enabled plates";

  return (
    <div className="ws-panel-stack">
      {/* ----- quick export (legacy topbar Export menu contract) ----- */}
      <div className="ws-quick-export" role="group" aria-label="Quick export">
        {quickTargets.map(([label, hint, chosen]) => (
          <button
            key={label}
            type="button"
            className="ws-quick-export-item"
            disabled={exporting || (chosen.format === "svg" && !vector.eligible)}
            onClick={() => quickExport(chosen)}
          >
            <Icon name="download" size={14} />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </button>
        ))}
      </div>

      <NumericField
        id="opacity"
        label="Ink opacity"
        value={Math.round(settings.opacity * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        defaultValue={100}
        onChange={(value) => api.updateSetting("opacity", value / 100)}
      />
      {/* ----- target selection ----- */}

      <div
        className="artwork-control-group"
        role="radiogroup"
        aria-label="Export target"
      >
        <span className="artwork-control-label">Export target</span>
        {(
          [
            ["composite", "Composite"],
            ["plate-package", "Plates"],
            ["selected-layer", "Selected Layer"],
          ] as const
        ).map(([kind, label]) => (
          <label key={kind} className="ws-radio-row">
            <input
              type="radio"
              name="export-target"
              aria-label={label}
              checked={state.targetKind === kind}
              disabled={kind === "selected-layer" && !api.exportPipeline.selectedLayerId}
              onChange={() => session.setTargetKind(kind)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      {state.targetKind === "composite" && (
        <div className="artwork-control-group" role="radiogroup" aria-label="Format">
          <span className="artwork-control-label">Format</span>
          {(
            [
              ["png", "PNG"],
              ["jpeg", "JPEG"],
              ["tiff", "TIFF"],
            ] as const
          ).map(([format, label]) => (
            <label key={format} className="ws-radio-row">
              <input
                type="radio"
                name="composite-format"
                aria-label={label}
                checked={state.compositeFormat === format}
                onChange={() => session.setCompositeFormat(format)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}

      {state.targetKind === "selected-layer" && (
        <div
          className="artwork-control-group"
          role="radiogroup"
          aria-label="Layer format"
        >
          <span className="artwork-control-label">Layer format</span>
          {(
            [
              ["png", "PNG"],
              ["tiff", "TIFF"],
            ] as const
          ).map(([format, label]) => (
            <label key={format} className="ws-radio-row">
              <input
                type="radio"
                name="layer-format"
                aria-label={label}
                checked={state.layerFormat === format}
                onChange={() => session.setLayerFormat(format)}
              />
              <span>{label}</span>
            </label>
          ))}
          <p className="control-state-note">
            Full-artboard transparent cutout of the selected layer, placement
            preserved.
          </p>
        </div>
      )}

      {state.targetKind === "plate-package" && (
        <div
          className="artwork-control-group"
          role="radiogroup"
          aria-label="Plate format"
        >
          <span className="artwork-control-label">Plate format</span>
          {(
            [
              ["png", "Raster PNG (ZIP)"],
              ["svg", "Vector SVG (ZIP)"],
            ] as const
          ).map(([format, label]) => (
            <label key={format} className="ws-radio-row">
              <input
                type="radio"
                name="plate-format"
                aria-label={label}
                checked={plateFormat === format}
                disabled={format === "svg" && !vector.eligible}
                onChange={() => session.setPlateFormat(format)}
              />
              <span>{label}</span>
            </label>
          ))}
          {!vector.eligible && (
            <p
              className="control-state-note"
              data-testid="ws-vector-ineligible-reason"
            >
              Vector plates unavailable:{" "}
              {vector.ineligibleLayers[0]?.reason ??
                "a contributing layer has no vector representation; export raster plates instead."}
            </p>
          )}
        </div>
      )}

      <label className="toggle-row">
        <span>
          <strong>Registration marks</strong>
          <small>
            Defaults on for plate packages, off for composite and layer
            exports.
          </small>
        </span>
        <input
          type="checkbox"
          checked={registrationChecked}
          onChange={(event) => onRegistrationToggle(event.target.checked)}
        />
      </label>

      {/* ----- preflight ----- */}

      <section className="preflight-card" aria-labelledby="preflight-title">
        <header className="preflight-heading">
          <span>
            <Icon name="clipboard-check" size={16} />
            <strong id="preflight-title">Output preflight</strong>
          </span>
          <span data-testid="preflight-count">
            {preflight.reviewCount === 0
              ? "No findings"
              : `${preflight.reviewCount} to review`}
          </span>
        </header>
        <ul className="preflight-list" data-testid="ws-preflight-list">
          {/* Legacy five-row summary (press workflow contract). */}
          <PreflightSummaryItem
            review={preflight.hiddenPlates.length > 0}
            label="Plate visibility"
            value={
              preflight.hiddenPlates.length === 0
                ? "4/4 enabled"
                : `${preflight.hiddenPlates
                    .map((plate) => PLATE_META[plate].short)
                    .join(", ")} hidden`
            }
          />
          <PreflightSummaryItem
            review={preflight.sharedAngleGroups.length > 0}
            label="Screen angles"
            value={
              preflight.sharedAngleGroups.length === 0
                ? settings.grayscale
                  ? "Grayscale uses the K screen angle"
                  : "All four angles are distinct"
                : preflight.sharedAngleGroups
                    .map(
                      ([angle, plates]) =>
                        `${plates
                          .map((plate) => PLATE_META[plate].short)
                          .join("/")} share ${angle}°`,
                    )
                    .join(" · ")
            }
          />
          <PreflightSummaryItem
            review={preflight.registrationOff}
            label="Registration"
            value={preflight.registrationOff ? "Off — confirm before film" : "Marks included"}
          />
          <PreflightSummaryItem
            review={preflight.polarityInverted}
            label="Dot polarity"
            value={preflight.polarityInverted ? "Inverted — confirm" : "Standard positive"}
          />
          <PreflightSummaryItem
            review={preflight.dense}
            label="Screen load"
            value={summaryValueScreenLoad}
          />
          {/* Target preflight (evaluate) issues, severity-tagged. */}
          {issues.map((issue) => (
            <li
              key={issue.id}
              data-severity={issue.severity}
              className={issue.severity === "block" ? "needs-review" : ""}
            >
              <Icon name="warning" size={14} />
              <span>
                <strong>{issue.severity === "block" ? "Blocked" : "Review"}</strong>
                <small>{issue.message}</small>
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="preflight-copy" onClick={api.copyJobTicket}>
          <Icon name="copy" size={14} />
          Copy job ticket
        </button>
      </section>

      {blocks.length > 0 && (
        <p
          className="control-state-note is-error"
          data-testid="ws-export-blocked-reason"
          role="alert"
        >
          {blocks[0].message}
        </p>
      )}

      {/* ----- run ----- */}

      {exporting && (
        <div className="ws-export-run">
          <div
            className="ws-export-progress"
            data-testid="ws-export-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((state.run?.progress ?? 0) * 100)}
            aria-label="Export progress"
          >
            <span style={{ width: `${Math.round((state.run?.progress ?? 0) * 100)}%` }} />
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => session.cancel()}
          >
            Cancel Export
          </button>
        </div>
      )}

      <button
        type="button"
        className="button primary"
        disabled={!target || blocks.length > 0 || exporting}
        onClick={onExportNow}
      >
        Export Now
      </button>

      <button
        type="button"
        className="button secondary"
        onClick={api.resetOutput}
      >
        Reset output controls
      </button>

      {state.pendingWarnings && (
        <ChoiceDialog
          title="Review warnings"
          description={
            <ul className="ws-warning-list">
              {state.pendingWarnings.issues
                .filter((issue: PreflightIssue) => issue.severity === "warn")
                .map((issue: PreflightIssue) => (
                  <li key={issue.id}>{issue.message}</li>
                ))}
            </ul>
          }
          choices={[
            {
              label: "Export Anyway",
              onChoose: () => {
                const pending = state.pendingWarnings;
                if (!pending) return;
                api.exportPipeline.confirmWarnings(pending.issues);
                session.setPendingWarnings(null);
                begin(pending.target);
              },
            },
          ]}
          onCancel={() => session.setPendingWarnings(null)}
        />
      )}
    </div>
  );
}
