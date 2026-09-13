/**
 * Export session store — studio-session-level ownership of the export
 * WORKFLOW state (target choice, live run progress/cancel, pending warning
 * confirmation). The Preflight/Export panel is conditionally mounted by the
 * workspace shell (tool switches, Focus Mode, placement changes unmount it);
 * this store lives with the studio session so a re-mounted panel binds back
 * into the live state instead of losing a running job.
 *
 * Invariants:
 * - ONE export at a time: start() rejects (returns null) while a run is
 *   live, whichever surface asked (panel Export Now or the topbar quick
 *   menu).
 * - cancel() reaches the CURRENT run even if the panel that started it has
 *   unmounted and re-mounted since.
 * - Snapshots are immutable; subscribe/getState fit useSyncExternalStore.
 *
 * React-free: fully unit-testable with fake starters.
 */

import type { PreflightIssue } from "../core/types";
import type { ExportTarget } from "./targets";

export type ExportTargetKind = ExportTarget["kind"];
export type ExportRunStatus = "done" | "cancelled" | "error";

/** The studio's raw run starter (StudioApi.exportPipeline.start). */
export type ExportStarter = (
  target: ExportTarget,
  hooks: { onProgress?(fraction: number): void },
) => { cancel(): void; done: Promise<ExportRunStatus> };

export type PendingWarnings = {
  target: ExportTarget;
  issues: PreflightIssue[];
};

export type ExportSessionState = {
  targetKind: ExportTargetKind;
  compositeFormat: "png" | "jpeg" | "tiff";
  plateFormat: "png" | "svg";
  /** Selected-layer export format; persists with the session workflow. */
  layerFormat: "png" | "tiff";
  /** Selected-layer registration is session state (no document default). */
  layerRegistration: boolean;
  /**
   * The user explicitly toggled Registration marks for the CURRENT target;
   * their toggle IS the confirmation for the registration-default warnings
   * (resets when the target changes).
   */
  registrationTouched: boolean;
  pendingWarnings: PendingWarnings | null;
  /** Live run snapshot; null while idle. */
  run: { target: ExportTarget; progress: number } | null;
};

export type ExportRunHandle = {
  cancel(): void;
  done: Promise<ExportRunStatus>;
};

const INITIAL_STATE: ExportSessionState = {
  // Plate packages are the press-workflow default target (the panel is the
  // preflight surface; registration defaults follow the document).
  targetKind: "plate-package",
  compositeFormat: "png",
  plateFormat: "png",
  layerFormat: "png",
  layerRegistration: false,
  registrationTouched: false,
  pendingWarnings: null,
  run: null,
};

export class ExportSessionStore {
  private state: ExportSessionState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private cancelCurrent: (() => void) | null = null;
  /** Identity of the LIVE run; stale runs' progress/finish are no-ops. */
  private runToken: object | null = null;

  getState(): ExportSessionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private setState(patch: Partial<ExportSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  get running(): boolean {
    return this.state.run !== null;
  }

  setTargetKind(kind: ExportTargetKind): void {
    if (kind === this.state.targetKind) return;
    this.setState({
      targetKind: kind,
      registrationTouched: false,
      pendingWarnings: null,
    });
  }

  setCompositeFormat(format: ExportSessionState["compositeFormat"]): void {
    this.setState({ compositeFormat: format });
  }

  setPlateFormat(format: ExportSessionState["plateFormat"]): void {
    this.setState({ plateFormat: format });
  }

  setLayerFormat(format: ExportSessionState["layerFormat"]): void {
    this.setState({ layerFormat: format });
  }

  setLayerRegistration(enabled: boolean): void {
    this.setState({ layerRegistration: enabled, registrationTouched: true });
  }

  /** Records an explicit registration toggle for warn-gating purposes. */
  markRegistrationTouched(): void {
    if (!this.state.registrationTouched) this.setState({ registrationTouched: true });
  }

  setPendingWarnings(pending: PendingWarnings | null): void {
    this.setState({ pendingWarnings: pending });
  }

  /**
   * Start ONE export. Returns null (and starts nothing) while another run
   * is live — duplicate starts are rejected at the session level so no
   * surface can race a second job past a re-mounted panel.
   */
  start(target: ExportTarget, starter: ExportStarter): ExportRunHandle | null {
    if (this.state.run !== null) return null;
    const token = {};
    this.runToken = token;
    this.setState({ run: { target, progress: 0 }, pendingWarnings: null });
    let run: ReturnType<ExportStarter>;
    try {
      run = starter(target, {
        onProgress: (fraction) => {
          // Token guard: a STALE run's progress can never paint the
          // current run's UI (same identity idiom as the Home flow).
          if (this.state.run !== null && this.runToken === token) {
            this.setState({ run: { ...this.state.run, progress: fraction } });
          }
        },
      });
    } catch (error) {
      // A synchronous starter throw must never wedge the session in a
      // running state that blocks every later export: roll back to idle
      // and surface the failure to the caller.
      this.finishRun(token);
      throw error;
    }
    this.cancelCurrent = run.cancel;
    const done = run.done.then(
      (status) => {
        this.finishRun(token);
        return status;
      },
      (error: unknown) => {
        this.finishRun(token);
        throw error;
      },
    );
    // TOKEN-BOUND handle cancel: a retained handle from run A must never
    // kill a later run B — the handle cancels only while ITS run is live.
    // store.cancel() remains the current-UI intent (the visible button).
    return {
      cancel: () => {
        if (this.runToken === token) this.cancel();
      },
      done,
    };
  }

  /** Cancel the live run (safe no-op while idle). */
  cancel(): void {
    this.cancelCurrent?.();
  }

  private finishRun(token: object): void {
    // A stale run settling late must not clear (or hide) a newer run.
    if (this.runToken !== token) return;
    this.runToken = null;
    this.cancelCurrent = null;
    this.setState({ run: null });
  }
}

export function createExportSessionStore(): ExportSessionStore {
  return new ExportSessionStore();
}
