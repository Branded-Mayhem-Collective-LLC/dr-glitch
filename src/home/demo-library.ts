/**
 * In-memory ProjectLibraryApi binding for the dev route. Keeps the home
 * surface fully functional without IndexedDB; replaced by the storage
 * agent's repository binding in production wiring. Never persists.
 */

import { createId } from "../core/id";
import type { Id } from "../core/types";
import type { ProjectLibraryApi, ProjectSummary, TrashSummary } from "./library";

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function createDemoLibrary(now: () => number = Date.now): ProjectLibraryApi {
  const projects = new Map<Id, ProjectSummary>();
  const trash = new Map<Id, { summary: ProjectSummary; record: TrashSummary }>();

  function requireProject(id: Id): ProjectSummary {
    const project = projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return project;
  }

  function insert(title: string, unsaved: boolean): Id {
    const id = createId();
    const timestamp = now();
    projects.set(id, {
      id,
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      thumbnailUrl: null,
      unsaved,
    });
    return id;
  }

  return {
    async listProjects() {
      return [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async listTrash() {
      return [...trash.values()]
        .map(({ record }) => record)
        .sort((a, b) => b.deletedAt - a.deletedAt);
    },
    async createProject() {
      return insert("Untitled project", false);
    },
    async openProjectFile(file: File) {
      // Demo binding: no archive validation; the io agent owns the real path.
      const title = file.name.replace(/\.drglitch$/i, "") || "Imported project";
      return insert(title, true);
    },
    async openSample() {
      return insert("Sample — Print Loud", true);
    },
    async renameProject(id, title) {
      const project = requireProject(id);
      projects.set(id, { ...project, title: title.trim() || project.title, updatedAt: now() });
    },
    async duplicateProject(id) {
      const project = requireProject(id);
      const copyId = createId();
      const timestamp = now();
      projects.set(copyId, {
        ...project,
        id: copyId,
        title: `${project.title} copy`,
        createdAt: timestamp,
        updatedAt: timestamp,
        unsaved: false,
      });
      return copyId;
    },
    async exportProject(id) {
      const project = requireProject(id);
      const manifest = JSON.stringify({ schema: 1, demo: true, title: project.title });
      return {
        filename: `${project.title.replace(/[^\w\d-]+/g, "-") || "project"}.drglitch`,
        blob: new Blob([manifest], { type: "application/octet-stream" }),
      };
    },
    async trashProject(id) {
      const project = requireProject(id);
      projects.delete(id);
      const deletedAt = now();
      trash.set(id, {
        summary: project,
        record: {
          projectId: id,
          title: project.title,
          deletedAt,
          expiresAt: deletedAt + TRASH_RETENTION_MS,
        },
      });
    },
    async restoreProject(projectId) {
      const entry = trash.get(projectId);
      if (!entry) throw new Error(`Trash entry not found: ${projectId}`);
      trash.delete(projectId);
      projects.set(projectId, { ...entry.summary, updatedAt: now() });
    },
    async deletePermanently(projectId) {
      trash.delete(projectId);
    },
    async emptyTrash() {
      trash.clear();
    },
  };
}
