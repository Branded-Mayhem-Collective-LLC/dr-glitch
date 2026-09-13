/**
 * History / Snapshots panel. Undo/redo state comes from the project store
 * (topbar Undo/Redo are the actions; this panel shows depth and recent
 * transaction labels). Named snapshots persist with the project: create
 * (with a proof thumbnail), restore (one undoable action), duplicate to a
 * new unsaved project, delete, capped at ProjectUi.snapshotCap.
 */

import { useState } from "react";
import { useProjectUi } from "../project-ui";
import { TextPromptDialog } from "../dialogs";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoryPanel() {
  const project = useProjectUi();
  const [createOpen, setCreateOpen] = useState(false);
  const recentLabels = [...project.undoLabels].reverse().slice(0, 8);

  return (
    <div className="ws-panel-stack">
      <section aria-label="Undo history">
        <h3 className="ws-panel-section-title">Session history</h3>
        <p className="control-state-note" data-testid="ws-history-depth">
          {project.undoDepth === 0
            ? "Nothing to undo yet. Session history holds the last 100 edits."
            : `${project.undoDepth} undoable ${project.undoDepth === 1 ? "edit" : "edits"} · ${project.redoDepth} redoable`}
        </p>
        {recentLabels.length > 0 && (
          <ol className="ws-history-list" data-testid="ws-history-list">
            {recentLabels.map((label, index) => (
              <li key={`${index}-${label ?? "edit"}`}>{label ?? "Edit"}</li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Snapshots">
        <h3 className="ws-panel-section-title">Snapshots</h3>
        <button
          type="button"
          disabled={project.readOnly || project.snapshots.length >= project.snapshotCap}
          onClick={() => setCreateOpen(true)}
        >
          Create Snapshot
        </button>
        {project.snapshots.length >= project.snapshotCap && (
          <p className="control-state-note">
            Snapshot limit reached ({project.snapshotCap}). Delete one to
            create another.
          </p>
        )}
        {project.snapshots.length === 0 ? (
          <p className="control-state-note">
            No snapshots yet. A snapshot is a named checkpoint of the whole
            document you can restore or branch into a new project.
          </p>
        ) : (
          <ul className="ws-snapshot-list">
            {[...project.snapshots].reverse().map((snapshot) => (
              <li
                key={snapshot.id}
                className="ws-snapshot-row"
                data-testid="ws-snapshot-row"
              >
                <span className="ws-snapshot-name">{snapshot.name}</span>
                <span className="ws-snapshot-date">{formatTime(snapshot.createdAt)}</span>
                <span className="ws-snapshot-actions">
                  <button
                    type="button"
                    aria-label="Restore Snapshot"
                    title="Restore Snapshot — one undoable action"
                    disabled={project.readOnly}
                    onClick={() => project.restoreSnapshot(snapshot.id)}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    aria-label="Duplicate to New Project"
                    title="Duplicate to New Project — opens an unsaved copy"
                    onClick={() => project.duplicateSnapshotToProject(snapshot.id)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete snapshot ${snapshot.name}`}
                    disabled={project.readOnly}
                    onClick={() => project.deleteSnapshot(snapshot.id)}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {createOpen && (
        <TextPromptDialog
          title="Create Snapshot"
          fieldLabel="Snapshot name"
          submitLabel="Create"
          description={<p>Snapshots persist with the project and never leave this device.</p>}
          onSubmit={(name) => {
            setCreateOpen(false);
            void project.createSnapshot(name);
          }}
          onCancel={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}
