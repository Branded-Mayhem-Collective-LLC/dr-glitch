/**
 * Centralized workstation shortcuts.
 *
 * Every global single-key shortcut is declared here as data so the Help
 * dialog, the rail tooltips, and the key handler all read one registry.
 * Matching logic is pure and DOM-free (unit-tested in Node); the React hook
 * at the bottom is a thin listener.
 *
 * Suppression rules:
 * - unmodified single-key shortcuts never fire while the operator is typing
 *   in an input, textarea, select, or contenteditable surface, and never
 *   while a browser modifier (meta/ctrl/alt) is held;
 * - no workstation shortcut fires while a modal dialog is open (a keypress
 *   inside "Save Project" must never switch tools behind the scrim);
 * - the operator can turn every unmodified character-key shortcut off
 *   entirely (WCAG 2.1.4 Character Key Shortcuts) via the Workspace menu;
 *   the preference persists on this device. Modifier-based shortcuts
 *   (Ctrl/Cmd+Z etc.) are unaffected by that switch.
 */

import { useEffect, useRef } from "react";
import { TOOL_DEFINITIONS } from "../core/tool-registry";
import type { ToolId } from "../core/types";

/* ------------------------------------------------------------------ */
/* Character-key shortcut preference (WCAG 2.1.4)                      */
/* ------------------------------------------------------------------ */

export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY =
  "drglitch.workspace-single-key-shortcuts.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** True when the operator has turned unmodified character-key shortcuts off. */
export function readSingleKeyShortcutsDisabled(
  storage: StorageLike | null = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY) === "disabled";
  } catch {
    return false;
  }
}

export function writeSingleKeyShortcutsDisabled(
  disabled: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(
      SINGLE_KEY_SHORTCUTS_STORAGE_KEY,
      disabled ? "disabled" : "enabled",
    );
  } catch {
    // Quota/privacy failures degrade to the in-memory setting.
  }
}

/* ------------------------------------------------------------------ */
/* Modal suppression                                                   */
/* ------------------------------------------------------------------ */

/**
 * True when a modal dialog is open anywhere in the document. Floating
 * panels are role="dialog" but non-modal, so the check keys on aria-modal.
 */
export function isModalOpen(
  root: Pick<ParentNode, "querySelector"> | null =
    typeof document !== "undefined" ? document : null,
): boolean {
  return Boolean(root?.querySelector('[aria-modal="true"]'));
}

export type ShortcutBinding = {
  /** Stable id, e.g. "tool.halftone" or "view.focus-mode". */
  id: string;
  /** KeyboardEvent.key; single characters are compared lowercase. */
  key: string;
  /** Shown in Help and tooltips. */
  description: string;
  run: () => void;
};

/** Structural subset of KeyboardEvent so matching stays DOM-free. */
export type ShortcutKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
};

/**
 * True when the event target is a text-entry surface. Structural checks
 * (not instanceof) so the logic is testable without a DOM.
 */
export function isTypingTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof element.tagName === "string" ? element.tagName : "";
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    element.isContentEditable === true
  );
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export type ResolveShortcutOptions = {
  /** WCAG 2.1.4 switch: suppress every unmodified character-key binding. */
  singleKeyDisabled?: boolean;
  /** A modal dialog is open: suppress everything. */
  modalOpen?: boolean;
};

/**
 * Resolve an event against a binding list. Returns null when suppressed
 * (typing target, browser modifier held, modal open, or character-key
 * shortcuts turned off) or unbound.
 */
export function resolveShortcut(
  bindings: readonly ShortcutBinding[],
  event: ShortcutKeyEvent,
  options: ResolveShortcutOptions = {},
): ShortcutBinding | null {
  if (options.modalOpen) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  const key = normalizeKey(event.key);
  const match =
    bindings.find((binding) => normalizeKey(binding.key) === key) ?? null;
  if (!match) return null;
  // Every registry binding is an unmodified character key, so the WCAG
  // 2.1.4 switch suppresses any single-character binding it matched.
  if (options.singleKeyDisabled && normalizeKey(match.key).length === 1) {
    return null;
  }
  return match;
}

/* ------------------------------------------------------------------ */
/* Modifier shortcuts (Ctrl/Cmd combos)                                 */
/* ------------------------------------------------------------------ */

export type ModifierShortcutBinding = {
  /** Stable id, e.g. "edit.undo". */
  id: string;
  /** KeyboardEvent.key, compared lowercase; fires with Ctrl or Cmd held. */
  key: string;
  /** When set, the binding requires (true) or forbids (false) Shift. */
  shift?: boolean;
  /**
   * Fire even while typing in a text field (e.g. Save). Default false —
   * Undo/Redo must leave the field's native editing history alone.
   */
  allowWhileTyping?: boolean;
  description: string;
  run: () => void;
};

export type ModifierShortcutKeyEvent = ShortcutKeyEvent & {
  shiftKey: boolean;
};

/**
 * Resolve a Ctrl/Cmd combo. Unaffected by the WCAG 2.1.4 character-key
 * switch (these are the always-available alternative), still suppressed
 * while a modal dialog is open.
 */
export function resolveModifierShortcut(
  bindings: readonly ModifierShortcutBinding[],
  event: ModifierShortcutKeyEvent,
  options: Pick<ResolveShortcutOptions, "modalOpen"> = {},
): ModifierShortcutBinding | null {
  if (options.modalOpen) return null;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = normalizeKey(event.key);
  const match =
    bindings.find(
      (binding) =>
        normalizeKey(binding.key) === key &&
        (binding.shift === undefined || binding.shift === event.shiftKey),
    ) ?? null;
  if (!match) return null;
  if (!match.allowWhileTyping && isTypingTarget(event.target)) return null;
  return match;
}

/** One binding per registered tool shortcut, in rail order. */
export function createToolShortcuts(
  activate: (toolId: ToolId) => void,
): ShortcutBinding[] {
  return TOOL_DEFINITIONS.filter((tool) => tool.shortcut !== null).map(
    (tool) => ({
      id: `tool.${tool.id}`,
      key: tool.shortcut as string,
      description: `Activate ${tool.label}`,
      run: () => activate(tool.id),
    }),
  );
}

/** Listens on window; bindings may change identity freely between renders. */
export function useWorkspaceShortcuts(
  bindings: readonly ShortcutBinding[],
  options: Pick<ResolveShortcutOptions, "singleKeyDisabled"> & {
    modifierBindings?: readonly ModifierShortcutBinding[];
  } = {},
): void {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modalOpen = isModalOpen();
      const modifierMatch = resolveModifierShortcut(
        optionsRef.current.modifierBindings ?? [],
        event,
        { modalOpen },
      );
      if (modifierMatch) {
        event.preventDefault();
        modifierMatch.run();
        return;
      }
      const match = resolveShortcut(bindingsRef.current, event, {
        singleKeyDisabled: optionsRef.current.singleKeyDisabled,
        modalOpen,
      });
      if (!match) return;
      event.preventDefault();
      match.run();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
