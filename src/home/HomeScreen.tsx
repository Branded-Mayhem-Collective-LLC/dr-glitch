/**
 * Start/home surface (ws-home): Recent project cards, New Project, Open
 * Project File, Open Sample, and Trash. All data flows through the
 * ProjectLibraryApi prop, which the app spine binds to the storage
 * repositories. Projects and artwork stay on this device; accounts never
 * sync files.
 *
 * Accessible names and testids here (ws-home, ws-project-card, "Project
 * actions", ws-trash, ws-open-project-input, "Rename Project" /
 * "Delete Permanently" / "Empty Trash" dialogs) are part of the binding e2e
 * selector contract (tests/e2e/helpers/workstation.ts).
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./home.css";
import { RESOURCE_POLICY } from "../core/resource-policy";
/* Home-surface a11y rules (scroll container, focus rings) live with the
 * workspace a11y sheet this wave; see the note inside that file. */
import "../workspace/workstation-a11y.css";
import type { Id } from "../core/types";
import type {
  ProjectImportProgress,
  ProjectLibraryApi,
  ProjectSummary,
  TrashSummary,
} from "./library";
import { ConfirmDialog } from "./DirtyWorkDialog";
import {
  describeImportProgress,
  IMPORT_CANCELLED_NOTICE,
  isImportCancelled,
} from "./import-flow";
import { ModalDialog } from "../workspace/ModalDialog";

export type HomeScreenProps = {
  library: ProjectLibraryApi;
  /** Navigates into the studio with the given project. */
  onOpenProject: (id: Id) => void;
};

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ProjectCard({
  project,
  onOpen,
  onRename,
  onDuplicate,
  onExport,
  onTrash,
}: {
  project: ProjectSummary;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onTrash: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const items = [
    { label: "Rename", run: onRename },
    { label: "Duplicate", run: onDuplicate },
    { label: "Export Project", run: onExport },
    { label: "Move to Trash", run: onTrash },
  ];

  // Full menu-button pattern: opening moves focus to the first item.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menuOpen]);

  function closeMenu(refocusTrigger: boolean) {
    setMenuOpen(false);
    if (refocusTrigger) triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const menuItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const index = menuItems.findIndex((item) => item === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      menuItems[(index + 1) % menuItems.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      menuItems[(index - 1 + menuItems.length) % menuItems.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      menuItems[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      menuItems[menuItems.length - 1]?.focus();
    }
  }

  return (
    <li className="home-project-card" data-testid="ws-project-card">
      {project.thumbnailUrl ? (
        <img src={project.thumbnailUrl} alt="" className="home-project-thumb" />
      ) : (
        <div className="home-project-thumb is-blank" aria-hidden="true" />
      )}
      <h3 className="home-project-title">
        {project.title}
        {project.unsaved ? <span className="home-unsaved-badge"> Unsaved</span> : null}
      </h3>
      <p className="home-project-date">Updated {formatDate(project.updatedAt)}</p>
      <div className="home-project-actions">
        <button type="button" onClick={onOpen}>
          Open
        </button>
        <div className="home-project-menu-wrap">
          <button
            ref={triggerRef}
            type="button"
            aria-label="Project actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={`Actions for ${project.title}`}
              className="home-project-menu"
              onKeyDown={onMenuKeyDown}
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  closeMenu(false);
                }
              }}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    // Refocus the trigger BEFORE running: dialogs opened by
                    // a menu item capture the focused element as their
                    // opener, so Escape/Cancel/complete returns focus to
                    // the "Project actions" button, never <body>.
                    closeMenu(true);
                    item.run();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function HomeScreen({ library, onOpenProject }: HomeScreenProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [trash, setTrash] = useState<TrashSummary[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<Id | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Live cancellable .drglitch import; null while idle. */
  const [importing, setImporting] = useState<{
    filename: string;
    progress: ProjectImportProgress | null;
    cancel: () => void;
  } | null>(null);

  /**
   * Cancellable .drglitch intake: progress + a Cancel that aborts the whole
   * operation at its next checkpoint (typed rejection, exactly-once
   * cleanup, nothing installed). Bindings without the cancellable seam fall
   * back to the plain awaited import.
   */
  async function importProjectFile(file: File) {
    if (!library.importProjectFileCancellable) {
      await run(async () => {
        onOpenProject(await library.openProjectFile(file));
      }, "That project file could not be opened.");
      return;
    }
    if (importing) return; // one import at a time
    setNotice(null);
    const handle = library.importProjectFileCancellable(file);
    const unsubscribe = handle.onProgress((progress) => {
      setImporting((current) =>
        current ? { ...current, progress } : current,
      );
    });
    setImporting({ filename: file.name, progress: null, cancel: handle.cancel });
    try {
      const id = await handle.promise;
      onOpenProject(id);
    } catch (error) {
      if (isImportCancelled(error)) {
        setNotice(IMPORT_CANCELLED_NOTICE);
      } else {
        setNotice(
          error instanceof Error && error.message
            ? error.message
            : "That project file could not be opened.",
        );
      }
      await refresh();
    } finally {
      unsubscribe();
      setImporting(null);
    }
  }

  const refresh = useCallback(async () => {
    try {
      const [projectList, trashList] = await Promise.all([
        library.listProjects(),
        library.listTrash(),
      ]);
      setProjects(projectList);
      setTrash(trashList);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The project library could not load.");
    }
  }, [library]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>, failure: string) {
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : failure);
    }
  }

  /** Live archive export; carries the cancel affordance for the delivery. */
  const [exportRun, setExportRun] = useState<{ cancel: () => void; finalizing?: boolean } | null>(
    null,
  );
  /** Run-identity token: stale completions/cancels are no-ops. */
  const exportTokenRef = useRef(0);
  const exportAbortRef = useRef<(() => void) | null>(null);
  const exportProgressRef = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      // Unmount mid-export: abort and drain — never an orphaned writable.
      exportAbortRef.current?.();
    },
    [],
  );

  async function onExport(id: Id, title: string) {
    // Duplicate-run guard: one archive export at a time.
    if (exportAbortRef.current) {
      setNotice("A project export is already in progress.");
      return;
    }
    const returnFocus =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const restoreProgressFocus = (): void => {
      if (
        returnFocus?.isConnected &&
        exportProgressRef.current?.contains(document.activeElement)
      ) {
        returnFocus.focus();
      }
    };
    await run(async () => {
      const pickerHost = globalThis as {
        showSaveFilePicker?: (options?: {
          suggestedName?: string;
          types?: { accept: Record<string, string[]> }[];
        }) => Promise<{
          createWritable(): Promise<{
            write(data: Uint8Array | Blob): Promise<void>;
            close(): Promise<void>;
            abort?(reason?: unknown): Promise<void>;
          }>;
        }>;
      };
      // PICKER FIRST (accepted always-FSA simplification for project
      // archives): showSaveFilePicker is the FIRST call on the click path —
      // zero awaits between the user's activation and the dialog — because
      // any async plan/IDB read can lose transient activation. The
      // filename derives synchronously from the row's title (the same
      // sanitation the controller applies). Small archives simply write
      // their buffered bytes through the SAME writable; large archives
      // stream entry-wise — one delivery path, no anchor downloads when
      // FSA exists.
      if (
        typeof pickerHost.showSaveFilePicker === "function" &&
        library.exportProjectToSink &&
        library.planProjectExport
      ) {
        // RUN REGISTRATION FIRST (all synchronous): token, controller, and
        // the cancel affordance exist BEFORE the picker call, so even a
        // pending picker/createWritable is cancellable, stale completions
        // are token-guarded no-ops, and exactly ONE terminal outcome
        // reaches the UI.
        const token = ++exportTokenRef.current;
        const controller = new AbortController();
        // MEMOIZED, BOUNDED writable abort — ONE promise shared by every
        // caller (cancel listener, catch path, finally), so the writable
        // is aborted exactly once and no second awaiter can hang on an
        // already-aborted stream (same idiom as the studio sink).
        let liveWritable: {
          abort?(reason?: unknown): Promise<void>;
        } | null = null;
        // Memoized PER ACTUAL WRITABLE (never per call): a cancel arriving
        // before createWritable resolves is a mark only — the late
        // writable still gets its one real abort when it exists.
        const abortedWritables = new WeakMap<object, Promise<void>>();
        const abortWritableOnce = (reason?: unknown): Promise<void> => {
          const target = liveWritable;
          if (!target?.abort) return Promise.resolve();
          const existing = abortedWritables.get(target);
          if (existing) return existing;
          const abortPromise = Promise.race([
            Promise.resolve()
              .then(() => target.abort!(reason))
              .then(() => undefined)
              .catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 200)),
          ]);
          abortedWritables.set(target, abortPromise);
          return abortPromise;
        };
        let terminal: "open" | "closing" | "closed" | "aborted" = "open";
        const currentTerminal = (): typeof terminal => terminal;
        const cancelRun = () => {
          if (terminal === "closed" || terminal === "aborted") return;
          terminal = "aborted";
          controller.abort();
          void abortWritableOnce(new DOMException("Aborted", "AbortError"));
        };
        exportAbortRef.current = cancelRun;
        setExportRun({ cancel: cancelRun });
        const raceSignal = async <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
              (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
              },
              (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
          });
        };
        const raceCancel = <T,>(promise: Promise<T>): Promise<T> =>
          raceSignal(promise, controller.signal);
        const suggestedName = `${title.replace(/[^\w\d-]+/g, "-").replace(/^-+|-+$/g, "") || "project"}.drglitch`;
        try {
          // The picker is the FIRST post-registration operation — no await
          // between the user's activation and the dialog. Raced against
          // cancel; a late-resolving handle is dropped untouched.
          const pickerPromise = pickerHost.showSaveFilePicker({
            suggestedName,
            types: [{ accept: { "application/zip": [".drglitch"] } }],
          });
          pickerPromise.catch(() => undefined);
          const handle = await raceCancel(pickerPromise);
          // A late writable from a cancelled open is owned by the
          // containment below (aborted exactly once, error-contained).
          const writablePromise = handle.createWritable();
          writablePromise.catch(() => undefined);
          let writable: Awaited<typeof writablePromise>;
          try {
            writable = await raceCancel(writablePromise);
          } catch (error) {
            // A LATE-resolving writable joins the memoized abort exactly
            // once, error-contained.
            void writablePromise
              .then((late) => {
                liveWritable = late;
                return abortWritableOnce();
              })
              .catch(() => undefined);
            throw error;
          }
          liveWritable = writable;
          try {
            // ONE delivery/cancel architecture on FSA: EVERY size streams
            // entry-wise through the same signal-checked sink (small
            // archives stream trivially); the Blob path exists only for
            // no-FSA-under-threshold delivery.
            await library.exportProjectToSink(
              id,
              {
                write: async (chunk, writeSignal = controller.signal) => {
                  await raceSignal(
                    Promise.resolve().then(() => writable.write(chunk)),
                    writeSignal,
                  );
                },
                abort: (reason) => abortWritableOnce(reason),
              },
              { signal: controller.signal },
            );
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            // Closing is still cancellable. The first terminal event wins:
            // close fulfillment commits, while a cancel aborts the
            // transactional writable and a late close is ignored.
            terminal = "closing";
            if (token === exportTokenRef.current) {
              setExportRun({ cancel: cancelRun, finalizing: true });
            }
            const closePromise = Promise.resolve().then(() => writable.close());
            closePromise.catch(() => undefined);
            await raceSignal(closePromise, controller.signal);
            if (currentTerminal() === "aborted") {
              throw new DOMException("Aborted", "AbortError");
            }
            terminal = "closed";
          } catch (error) {
            if (terminal !== "closed") {
              terminal = "aborted";
              await abortWritableOnce(error);
            }
            throw error;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            // Dismissed picker before any write is the same clean-cancel
            // terminal as a mid-stream cancel.
            if (token === exportTokenRef.current) setNotice("Export cancelled");
            return;
          }
          throw error;
        } finally {
          if (token === exportTokenRef.current) {
            exportAbortRef.current = null;
            restoreProgressFocus();
            setExportRun(null);
          }
        }
        return;
      }
      // No File System Access: buffered anchor download, refused above the
      // in-memory cap (a whole-archive Blob of that size must never exist).
      // ONE LIFECYCLE with the streamed branch: run token + controller +
      // duplicate guard + unmount abort, and the download trigger is
      // token/cancel-guarded so no anchor can fire after cancel/unmount.
      const token = ++exportTokenRef.current;
      const controller = new AbortController();
      const cancelRun = () => controller.abort();
      exportAbortRef.current = cancelRun;
      setExportRun({ cancel: cancelRun });
      try {
        if (library.planProjectExport) {
          const plan = await library.planProjectExport(id, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (plan.estimatedBytes > RESOURCE_POLICY.maxBlobDownloadBytes) {
            throw new Error(
              "This project archive is larger than the in-memory download limit, and this " +
                "browser cannot stream exports to disk. Use Chrome or Edge.",
            );
          }
          if (
            plan.bufferedPeakBytes !== undefined &&
            plan.bufferedPeakBytes > RESOURCE_POLICY.maxRenderPeakBytes
          ) {
            throw new Error(
              "This project exceeds the safe in-memory export budget, and this browser cannot " +
                "stream exports to disk. Use Chrome or Edge.",
            );
          }
        }
        const { filename, blob } = await library.exportProject(id, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || token !== exportTokenRef.current) return;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        if (token === exportTokenRef.current) {
          exportAbortRef.current = null;
          restoreProgressFocus();
          setExportRun(null);
        }
      }
    }, "The project could not be exported.");
  }

  return (
    // <main>: the home surface is the page's main landmark, and it scrolls
    // internally (see .home-screen overflow rules) because the app shell
    // keeps body overflow hidden.
    <main className="home-screen" data-testid="ws-home">
      <header className="home-header">
        <h1>Projects</h1>
        <p className="home-storage-note">
          Projects and artwork stay on this device. Your account never syncs files.
        </p>
        <div className="home-actions">
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                onOpenProject(await library.createProject());
              }, "A new project could not be created.")
            }
          >
            New Project
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Open Project File
          </button>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                onOpenProject(await library.openSample());
              }, "The sample project could not open.")
            }
          >
            Open Sample
          </button>
          {/* Contract (§1.6): button "Trash" REVEALS the ws-trash view.
              Idempotent open (not a toggle): flows like trash → restore →
              trash again must always land on the visible trash list.
              aria-expanded (not aria-pressed) — it discloses a region. */}
          <button
            type="button"
            aria-expanded={trashOpen}
            aria-controls="home-trash-region"
            onClick={() => setTrashOpen(true)}
          >
            Trash
          </button>
          <input
            ref={fileInputRef}
            data-testid="ws-open-project-input"
            type="file"
            accept=".drglitch,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importProjectFile(file);
            }}
          />
        </div>
        {importing && (
          <div
            className="home-import-progress"
            data-testid="ws-import-progress"
            role="status"
            aria-label="Project import progress"
          >
            <span>
              {describeImportProgress(importing.filename, importing.progress)}
            </span>
            <button
              type="button"
              data-testid="ws-import-cancel"
              onClick={importing.cancel}
            >
              Cancel Import
            </button>
          </div>
        )}
      </header>

      {notice ? (
        <p role="alert" className="home-notice">
          {notice}
        </p>
      ) : null}

      {exportRun ? (
        <div
          ref={exportProgressRef}
          className="home-import-progress"
          data-testid="ws-export-archive-progress"
        >
          <span role="status" aria-live="polite" aria-atomic="true">
            {exportRun.finalizing ? "Finalizing project archive…" : "Exporting project archive…"}
          </span>
          <button type="button" onClick={() => exportRun.cancel()}>
            Cancel Export
          </button>
        </div>
      ) : null}

      <section aria-labelledby="home-recent-title">
        {/* "Recent projects" is the region's binding accessible name in the
          * e2e selector contract (workspace-shell home-surface entry). */}
        <h2 id="home-recent-title">Recent projects</h2>
        {projects.length === 0 ? (
          <p className="home-empty">
            No projects yet. Start with New Project or Open Sample.
          </p>
        ) : (
          <ul className="home-project-grid">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => onOpenProject(project.id)}
                onRename={() => setRenaming(project)}
                onDuplicate={() =>
                  void run(async () => {
                    await library.duplicateProject(project.id);
                  }, "The project could not be duplicated.")
                }
                onExport={() => void onExport(project.id, project.title)}
                onTrash={() =>
                  void run(
                    () => library.trashProject(project.id),
                    "The project could not be moved to Trash.",
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>

      {trashOpen && (
        <section
          id="home-trash-region"
          aria-labelledby="home-trash-title"
          data-testid="ws-trash"
        >
          <h2 id="home-trash-title">Trash</h2>
          {trash.length === 0 ? (
            <p className="home-empty">Trash is empty. Deleted projects are kept for 30 days.</p>
          ) : (
            <>
              <ul className="home-trash-list">
                {trash.map((entry) => (
                  <li key={entry.projectId} className="home-trash-row">
                    <span className="home-trash-title">{entry.title}</span>
                    <span className="home-trash-date">
                      Deleted {formatDate(entry.deletedAt)} · gone after {formatDate(entry.expiresAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void run(
                          () => library.restoreProject(entry.projectId),
                          "The project could not be restored.",
                        )
                      }
                    >
                      Restore
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteId(entry.projectId)}>
                      Delete Permanently
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setConfirmEmptyTrash(true)}>
                Empty Trash
              </button>
            </>
          )}
        </section>
      )}

      {renaming && (
        <RenameProjectDialog
          initialValue={renaming.title}
          onSubmit={(title) => {
            const id = renaming.id;
            setRenaming(null);
            void run(() => library.renameProject(id, title), "The project could not be renamed.");
          }}
          onCancel={() => setRenaming(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete Permanently"
        confirmLabel="Delete Permanently"
        destructive
        scrimClassName="ws-dialog-scrim home-dialog-scrim"
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id !== null) {
            void run(() => library.deletePermanently(id), "The project could not be deleted.");
          }
        }}
        onCancel={() => setConfirmDeleteId(null)}
      >
        <p>This removes the project and its assets forever. There is no undo.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmEmptyTrash}
        title="Empty Trash"
        confirmLabel="Empty Trash"
        destructive
        scrimClassName="ws-dialog-scrim home-dialog-scrim"
        onConfirm={() => {
          setConfirmEmptyTrash(false);
          void run(() => library.emptyTrash(), "Trash could not be emptied.");
        }}
        onCancel={() => setConfirmEmptyTrash(false)}
      >
        <p>Every project in Trash is removed forever. There is no undo.</p>
      </ConfirmDialog>
    </main>
  );
}

/** "Rename Project" dialog matching the workstation dialog contract. */
function RenameProjectDialog({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <ModalDialog scrimClassName="ws-dialog-scrim home-dialog-scrim">
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={titleId}>Rename Project</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          <input
            ref={inputRef}
            type="text"
            aria-label="Project name"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="confirm-dialog-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={!value.trim()}>
              Rename
            </button>
          </div>
        </form>
      </div>
    </ModalDialog>
  );
}
