/**
 * Dirty-work guard: the one decision flow that protects unsaved work when
 * the user triggers New, Open, Home, or another destructive navigation.
 * Pure logic here; the DirtyWorkDialog component presents the choice.
 *
 * Contract:
 * - Not dirty: proceed immediately, never prompt.
 * - "save": save first; proceed only when the save succeeds. A failed save
 *   cancels the action — work is never lost to a failed save.
 * - "discard": proceed without saving.
 * - "cancel": stay exactly where we are.
 */

export type DirtyGuardChoice = "save" | "discard" | "cancel";

export type DirtyGuardOutcome =
  | { outcome: "proceed"; via: "clean" | "saved" | "discarded" }
  | { outcome: "cancelled"; reason: "user" | "save-failed"; error?: unknown };

export type DirtyGuardOptions = {
  isDirty: boolean;
  /** Presents Save / Discard / Cancel and resolves with the choice. */
  choose: () => Promise<DirtyGuardChoice>;
  /** Performs the explicit save; rejects on failure. */
  save: () => Promise<void>;
};

export async function guardDirtyWork(options: DirtyGuardOptions): Promise<DirtyGuardOutcome> {
  if (!options.isDirty) return { outcome: "proceed", via: "clean" };

  const choice = await options.choose();
  if (choice === "cancel") return { outcome: "cancelled", reason: "user" };
  if (choice === "discard") return { outcome: "proceed", via: "discarded" };

  try {
    await options.save();
    return { outcome: "proceed", via: "saved" };
  } catch (error) {
    return { outcome: "cancelled", reason: "save-failed", error };
  }
}
