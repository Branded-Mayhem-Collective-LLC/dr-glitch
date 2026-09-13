/**
 * Home-surface logic: dirty-work guard and the in-memory demo library.
 * (Named export-home-flows to fit the agreed tests/unit/export-* ownership
 * glob; the lead may rename to home-flows once ownership merges.)
 */

import { describe, expect, it } from "vitest";
import { guardDirtyWork, type DirtyGuardChoice } from "../../src/home/dirty-guard";
import { createDemoLibrary } from "../../src/home/demo-library";

describe("guardDirtyWork", () => {
  it("proceeds immediately without prompting when clean", async () => {
    let prompted = false;
    const result = await guardDirtyWork({
      isDirty: false,
      choose: async () => {
        prompted = true;
        return "cancel";
      },
      save: async () => {},
    });
    expect(result).toEqual({ outcome: "proceed", via: "clean" });
    expect(prompted).toBe(false);
  });

  it("saves then proceeds on 'save'", async () => {
    let saved = false;
    const result = await guardDirtyWork({
      isDirty: true,
      choose: async () => "save" as DirtyGuardChoice,
      save: async () => {
        saved = true;
      },
    });
    expect(saved).toBe(true);
    expect(result).toEqual({ outcome: "proceed", via: "saved" });
  });

  it("cancels when the save fails — work is never lost to a failed save", async () => {
    const failure = new Error("quota exceeded");
    const result = await guardDirtyWork({
      isDirty: true,
      choose: async () => "save" as DirtyGuardChoice,
      save: async () => {
        throw failure;
      },
    });
    expect(result).toEqual({ outcome: "cancelled", reason: "save-failed", error: failure });
  });

  it("proceeds without saving on 'discard'", async () => {
    let saved = false;
    const result = await guardDirtyWork({
      isDirty: true,
      choose: async () => "discard" as DirtyGuardChoice,
      save: async () => {
        saved = true;
      },
    });
    expect(saved).toBe(false);
    expect(result).toEqual({ outcome: "proceed", via: "discarded" });
  });

  it("stays put on 'cancel'", async () => {
    const result = await guardDirtyWork({
      isDirty: true,
      choose: async () => "cancel" as DirtyGuardChoice,
      save: async () => {},
    });
    expect(result).toEqual({ outcome: "cancelled", reason: "user" });
  });
});

describe("demo project library", () => {
  it("creates, lists, renames, and duplicates projects", async () => {
    let clock = 1000;
    const library = createDemoLibrary(() => clock);
    const id = await library.createProject();
    clock = 2000;
    await library.renameProject(id, "Poster Run");
    clock = 3000;
    const copyId = await library.duplicateProject(id);
    const projects = await library.listProjects();
    expect(projects.map(({ title }) => title)).toEqual(["Poster Run copy", "Poster Run"]);
    expect(projects.every((project) => !project.unsaved)).toBe(true);
    expect(copyId).not.toBe(id);
  });

  it("keeps an empty rename from clobbering the title", async () => {
    const library = createDemoLibrary();
    const id = await library.createProject();
    await library.renameProject(id, "   ");
    const [project] = await library.listProjects();
    expect(project.title).toBe("Untitled project");
  });

  it("opens the sample and imported files as unsaved projects", async () => {
    const library = createDemoLibrary();
    await library.openSample();
    await library.openProjectFile(new File(["x"], "band-poster.drglitch"));
    const projects = await library.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.every((project) => project.unsaved)).toBe(true);
    expect(projects.some(({ title }) => title === "band-poster")).toBe(true);
  });

  it("moves projects through Trash with 30-day expiry, restore, and permanent delete", async () => {
    let clock = 10_000;
    const library = createDemoLibrary(() => clock);
    const keepId = await library.createProject();
    const dropId = await library.createProject();
    clock = 20_000;
    await library.trashProject(keepId);
    await library.trashProject(dropId);
    expect(await library.listProjects()).toEqual([]);
    const trash = await library.listTrash();
    expect(trash).toHaveLength(2);
    expect(trash[0].expiresAt - trash[0].deletedAt).toBe(30 * 24 * 60 * 60 * 1000);

    await library.restoreProject(keepId);
    expect((await library.listProjects()).map(({ id }) => id)).toEqual([keepId]);
    await library.deletePermanently(dropId);
    expect(await library.listTrash()).toEqual([]);
  });

  it("empties the Trash completely", async () => {
    const library = createDemoLibrary();
    await library.trashProject(await library.createProject());
    await library.trashProject(await library.createProject());
    await library.emptyTrash();
    expect(await library.listTrash()).toEqual([]);
  });

  it("exports a portable file with a safe filename", async () => {
    const library = createDemoLibrary();
    const id = await library.createProject();
    await library.renameProject(id, "Print / Loud");
    const { filename, blob } = await library.exportProject(id);
    expect(filename).toMatch(/\.drglitch$/);
    expect(filename).not.toContain("/");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("rejects operations on unknown projects", async () => {
    const library = createDemoLibrary();
    await expect(library.renameProject("nope", "x")).rejects.toThrow(/not found/);
    await expect(library.restoreProject("nope")).rejects.toThrow(/not found/);
  });
});
