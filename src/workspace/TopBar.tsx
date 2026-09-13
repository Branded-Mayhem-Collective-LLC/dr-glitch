/**
 * 48px top command bar. Home + project identity (title, dirty indicator,
 * recovery status, read-only badge), New/Open/Save wired to the local
 * project system, Undo/Redo bound to the project store (aria-disabled so
 * they keep their place in the tab order), Export, the Workspace menu
 * (Focus Mode / Lock Layout / Reset Layout), Help, account.
 *
 * Accessible names ("Home", "New", "Open", "Save", "Undo", "Redo",
 * "Export", "Workspace", "Help") and the ws-project-title /
 * ws-dirty-indicator / ws-recovery-status / ws-readonly-badge testids are
 * part of the binding e2e selector contract
 * (tests/e2e/helpers/workstation.ts).
 */

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import SessionBadge from "../auth/SessionBadge";
import ProcessLoader from "../components/ProcessLoader";
import { Icon } from "../components/icons";
import { PRODUCT_NAME } from "../brand";
import { useProjectUi } from "./project-ui";
import { useStudioApi } from "./studio-api";
import { useWorkspaceController } from "./workspace-controller";

type Props = {
  focusMode: boolean;
  locked: boolean;
  /** WCAG 2.1.4: unmodified character-key shortcuts are turned off. */
  singleKeyShortcutsDisabled: boolean;
  onToggleFocusMode: () => void;
  onToggleLock: () => void;
  onToggleSingleKeyShortcuts: () => void;
  onResetLayout: () => void;
  onOpenHelp: () => void;
};

export function TopBar({
  focusMode,
  locked,
  singleKeyShortcutsDisabled,
  onToggleFocusMode,
  onToggleLock,
  onToggleSingleKeyShortcuts,
  onResetLayout,
  onOpenHelp,
}: Props) {
  const api = useStudioApi();
  const project = useProjectUi();
  const workspace = useWorkspaceController();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!workspaceOpen) return;
    workspaceMenuRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
  }, [workspaceOpen]);

  function closeWorkspaceMenu(refocus: boolean) {
    setWorkspaceOpen(false);
    if (refocus) workspaceButtonRef.current?.focus();
  }

  function onWorkspaceMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      workspaceMenuRef.current?.querySelectorAll<HTMLButtonElement>("button") ??
        [],
    );
    const index = items.findIndex((item) => item === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeWorkspaceMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    }
  }

  const projectActions = [
    {
      id: "new",
      icon: "file-new",
      name: "New",
      title: "New project",
      run: project.requestNewProject,
      disabled: false,
    },
    {
      id: "open",
      icon: "file-open",
      name: "Open",
      title: "Open — browse your local projects",
      run: project.requestHome,
      disabled: false,
    },
    {
      id: "save",
      icon: "file-save",
      name: "Save",
      title: project.readOnly
        ? "Save — unavailable in a read-only tab"
        : "Save project on this device",
      run: project.requestSave,
      disabled: project.readOnly,
    },
  ] as const;

  const historyActions = [
    {
      id: "undo",
      icon: "undo",
      name: "Undo",
      enabled: project.canUndo && !project.readOnly,
      run: project.undo,
    },
    {
      id: "redo",
      icon: "redo",
      name: "Redo",
      enabled: project.canRedo && !project.readOnly,
      run: project.redo,
    },
  ] as const;

  return (
    <header className="ws-topbar" data-testid="ws-topbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <strong>{PRODUCT_NAME}</strong>
      </div>

      <button
        type="button"
        className="ws-topbar-button"
        aria-label="Home"
        title="Home — projects stay on this device"
        onClick={project.requestHome}
      >
        <Icon name="home" size={16} />
      </button>

      <div className="ws-project-identity">
        <Icon name="file-image" size={14} />
        {/* In the tab order between Home and New (the a11y visual-order walk
          * includes it): the visible rename affordance must be keyboard
          * reachable and activatable, not mouse-only. */}
        <button
          type="button"
          className="ws-project-name"
          data-testid="ws-project-title"
          title={`${project.title} — click or press Enter to rename`}
          onClick={project.requestRename}
        >
          {project.title}
        </button>
        {project.dirty && (
          <span
            className="ws-dirty-indicator"
            data-testid="ws-dirty-indicator"
            title="Unsaved changes — Save updates the canonical project"
          >
            ● Unsaved
          </span>
        )}
        {project.recoveryState === "flushed" && (
          <span
            className="ws-recovery-status"
            data-testid="ws-recovery-status"
            title="A recovery journal of your unsaved work is on this device"
          >
            Recovery saved
          </span>
        )}
        {project.readOnly && (
          <span className="ws-readonly-badge" data-testid="ws-readonly-badge">
            Read-only
            <button type="button" onClick={project.requestOwnership}>
              Request Ownership
            </button>
            <button type="button" onClick={project.duplicateReadonly}>
              Duplicate Project
            </button>
          </span>
        )}
        <span className="ws-project-status" data-testid="project-status">
          Local project — stays on this device; accounts don’t sync files
        </span>
      </div>

      <div className="ws-topbar-group" role="group" aria-label="Project">
        {projectActions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="ws-topbar-button"
            aria-disabled={action.disabled ? "true" : "false"}
            aria-label={action.name}
            title={action.title}
            onClick={() => {
              if (!action.disabled) action.run();
            }}
          >
            <Icon name={action.icon} size={16} />
          </button>
        ))}
      </div>

      <div className="ws-topbar-group" role="group" aria-label="History">
        {historyActions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="ws-topbar-button"
            aria-disabled={action.enabled ? "false" : "true"}
            aria-label={action.name}
            title={action.name}
            onClick={() => {
              if (action.enabled) action.run();
            }}
          >
            <Icon name={action.icon} size={16} />
          </button>
        ))}
      </div>

      <nav className="ws-topbar-actions" aria-label="Application actions">
        {/* Selector contract: topbar Export ACTIVATES the Preflight/Export
            tool — the identical workflow the rail entry reaches. */}
        <button
          className="button primary"
          aria-label="Export"
          title="Open the preflight/export workflow"
          onClick={() => workspace.activateTool("export")}
        >
          {api.exporting ? (
            <ProcessLoader compact label="Export running" />
          ) : (
            <Icon name="download" size={16} />
          )}
          Export
        </button>

        <button
          type="button"
          className="ws-topbar-button"
          aria-label="Help"
          title="Help — shortcuts and gestures (?)"
          onClick={onOpenHelp}
        >
          <Icon name="help" size={16} />
        </button>

        <div className="ws-panel-menu-wrap">
          <button
            ref={workspaceButtonRef}
            type="button"
            className="ws-topbar-button"
            aria-label="Workspace"
            aria-haspopup="menu"
            aria-expanded={workspaceOpen}
            title="Workspace — focus mode, lock, reset"
            onClick={() => setWorkspaceOpen((open) => !open)}
          >
            <Icon name={focusMode ? "focus-exit" : "focus-enter"} size={16} />
          </button>
          {workspaceOpen && (
            <div
              ref={workspaceMenuRef}
              className="ws-panel-menu"
              role="menu"
              aria-label="Workspace commands"
              onKeyDown={onWorkspaceMenuKeyDown}
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  closeWorkspaceMenu(false);
                }
              }}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={focusMode}
                onClick={() => {
                  closeWorkspaceMenu(true);
                  onToggleFocusMode();
                }}
              >
                Focus Mode {focusMode ? "· on" : ""}
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={locked}
                onClick={() => {
                  closeWorkspaceMenu(true);
                  onToggleLock();
                }}
              >
                Lock Layout {locked ? "· on" : ""}
              </button>
              {/* WCAG 2.1.4 Character Key Shortcuts: single-key tool/plate
                  shortcuts can be turned off; Ctrl/Cmd shortcuts and typing
                  suppression are unaffected. Persists on this device. */}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={singleKeyShortcutsDisabled}
                onClick={() => {
                  closeWorkspaceMenu(true);
                  onToggleSingleKeyShortcuts();
                }}
              >
                Disable single-key shortcuts{" "}
                {singleKeyShortcutsDisabled ? "· on" : ""}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeWorkspaceMenu(true);
                  onResetLayout();
                }}
              >
                Reset Layout
              </button>
            </div>
          )}
        </div>

        <div className="ws-topbar-account">
          <SessionBadge />
        </div>
      </nav>
    </header>
  );
}
