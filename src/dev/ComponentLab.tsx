/**
 * Development-only component lab (/dev/lab, `vite dev` only).
 *
 * Shows the workstation shell primitives in every state so chrome work can
 * be reviewed without loading artwork: icon map, rail buttons, titlebars,
 * drawer headers, splitter, size-gate copy, and focus treatment. Static
 * markup with the production classes — no studio state, no fake data
 * pretending to be a document.
 */

import { Icon } from "../components/icons";
import { TOOL_DEFINITIONS } from "../core/tool-registry";

const CHROME_ICONS = [
  "file-new",
  "file-open",
  "file-save",
  "undo",
  "redo",
  "download",
  "help",
  "lock",
  "unlock",
  "focus-enter",
  "focus-exit",
  "panel-menu",
  "dock-right",
  "move",
  "resize",
  "close",
  "warning",
  "check",
] as const;

export default function ComponentLab() {
  return (
    <main className="studio-shell ws-lab" data-studio-root>
      <div className="ws-lab-inner">
        <header className="ws-lab-header">
          <h1>Workstation component lab</h1>
          <p>
            Development-only. Atoms → molecules → organisms for the shell;
            documented in docs/specs/2026-09-12-workstation-architecture.md.
          </p>
        </header>

        <section className="ws-lab-section">
          <h2>Atoms · icon map</h2>
          <div className="ws-lab-grid">
            {TOOL_DEFINITIONS.map((tool) => (
              <figure key={tool.id}>
                <Icon name={tool.iconKey} size={19} />
                <figcaption>{tool.iconKey}</figcaption>
              </figure>
            ))}
            {CHROME_ICONS.map((key) => (
              <figure key={key}>
                <Icon name={key} size={19} />
                <figcaption>{key}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="ws-lab-section">
          <h2>Atoms · rail buttons</h2>
          <div className="ws-lab-row">
            <button type="button" className="ws-rail-button" aria-pressed="false">
              <Icon name="halftone" size={19} />
            </button>
            <button
              type="button"
              className="ws-rail-button is-active"
              aria-pressed="true"
            >
              <Icon name="halftone" size={19} />
            </button>
            <button
              type="button"
              className="ws-rail-button"
              aria-disabled="true"
            >
              <Icon name="glitch" size={19} />
            </button>
            <span>rest · active · disabled</span>
          </div>
        </section>

        <section className="ws-lab-section">
          <h2>Molecules · panel titlebar</h2>
          <div className="ws-lab-stack">
            <div className="ws-panel is-docked ws-lab-panel-sample">
              <header className="ws-panel-titlebar">
                <span className="ws-panel-title">Docked panel</span>
                <div className="ws-panel-titlebar-actions">
                  <button type="button" className="ws-titlebar-button" aria-label="Panel menu">
                    <Icon name="panel-menu" size={14} />
                  </button>
                  <button type="button" className="ws-titlebar-button" aria-label="Float">
                    <Icon name="move" size={14} />
                  </button>
                  <button type="button" className="ws-titlebar-button" aria-label="Close">
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </header>
              <div className="ws-panel-body">
                <p className="control-state-note">Panel body content area.</p>
              </div>
            </div>
            <div className="ws-panel is-floating is-focused ws-lab-panel-sample">
              <header className="ws-panel-titlebar" data-grabbable="true">
                <span className="ws-panel-title">Floating panel (focused)</span>
                <div className="ws-panel-titlebar-actions">
                  <button type="button" className="ws-titlebar-button" aria-label="Panel menu">
                    <Icon name="panel-menu" size={14} />
                  </button>
                  <button type="button" className="ws-titlebar-button" aria-label="Dock right">
                    <Icon name="dock-right" size={14} />
                  </button>
                  <button type="button" className="ws-titlebar-button" aria-label="Close">
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </header>
              <div className="ws-panel-body">
                <p className="control-state-note">
                  Escape cancels a move/resize gesture; Enter commits keyboard
                  move/resize.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="ws-lab-section">
          <h2>Molecules · drawer headers</h2>
          <div className="ws-drawers ws-lab-drawers">
            <section className="ws-drawer">
              <h2 className="ws-drawer-heading">
                <button type="button" className="ws-drawer-toggle" aria-expanded="true">
                  <span>Document</span>
                  <span className="ws-drawer-state" aria-hidden="true">−</span>
                </button>
              </h2>
            </section>
            <section className="ws-drawer">
              <h2 className="ws-drawer-heading">
                <button type="button" className="ws-drawer-toggle" aria-expanded="false">
                  <span>Proof</span>
                  <span className="ws-drawer-state" aria-hidden="true">+</span>
                </button>
              </h2>
            </section>
          </div>
        </section>

        <section className="ws-lab-section">
          <h2>Organisms · splitter and size gate copy</h2>
          <div className="ws-lab-row">
            <div
              className="ws-splitter ws-lab-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize tool dock (sample)"
              aria-valuemin={320}
              aria-valuemax={520}
              aria-valuenow={360}
              tabIndex={0}
            />
            <p className="desktop-only-body">
              “…needs at least a 1280×800 viewport. Your project and workspace
              layout are preserved — nothing collapses or resets.”
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
