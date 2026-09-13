/**
 * Top-level React error boundary. Narrow by design:
 * - Catches render/lifecycle crashes below it and reports ONE scrubbed
 *   stable-code event ("react-render-error") through the telemetry
 *   allowlist — no message, no component stack, no document data leaves
 *   the device (captureHandledError marks the error, so the SDK's global
 *   handlers cannot double-report it if React rethrows).
 * - Minimal recovery UI: an explanation and a Reload affordance. Saved
 *   projects and the crash-recovery journal are untouched by a render
 *   crash, and a reload reopens the last project with recovery applied.
 */
import { Component, type ReactNode } from "react";
import { captureHandledError } from "../telemetry/sentry";

type AppErrorBoundaryState = { failed: boolean };

export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    captureHandledError("react-render-error", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="app-error-boundary" data-testid="app-error-boundary">
        <h1>Something went wrong</h1>
        <p>
          DR.GLITCH hit an unexpected error. Your saved projects and crash
          recovery are untouched — reload to continue where you left off.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload DR.GLITCH
        </button>
      </div>
    );
  }
}
