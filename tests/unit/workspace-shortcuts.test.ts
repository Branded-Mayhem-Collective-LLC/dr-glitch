import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/core/tool-registry";
import {
  createToolShortcuts,
  isModalOpen,
  isTypingTarget,
  readSingleKeyShortcutsDisabled,
  resolveModifierShortcut,
  resolveShortcut,
  SINGLE_KEY_SHORTCUTS_STORAGE_KEY,
  writeSingleKeyShortcutsDisabled,
  type ShortcutBinding,
  type ShortcutKeyEvent,
} from "../../src/workspace/shortcuts";

function keyEvent(overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent {
  return {
    key: "h",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: null,
    ...overrides,
  };
}

const bindings: ShortcutBinding[] = [
  { id: "a", key: "h", description: "Halftone", run: () => {} },
  { id: "b", key: "[", description: "Smaller", run: () => {} },
  { id: "c", key: "?", description: "Help", run: () => {} },
];

describe("isTypingTarget", () => {
  it("treats inputs, textareas, selects, and contenteditable as typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("treats everything else as non-typing", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(
      false,
    );
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget("window")).toBe(false);
  });
});

describe("resolveShortcut", () => {
  it("matches unmodified single keys, case-insensitively", () => {
    expect(resolveShortcut(bindings, keyEvent({ key: "h" }))?.id).toBe("a");
    expect(resolveShortcut(bindings, keyEvent({ key: "H" }))?.id).toBe("a");
    expect(resolveShortcut(bindings, keyEvent({ key: "[" }))?.id).toBe("b");
    expect(resolveShortcut(bindings, keyEvent({ key: "?" }))?.id).toBe("c");
    expect(resolveShortcut(bindings, keyEvent({ key: "z" }))).toBeNull();
  });

  it("suppresses shortcuts while typing in text-entry surfaces", () => {
    for (const target of [
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "SPAN", isContentEditable: true },
    ]) {
      expect(resolveShortcut(bindings, keyEvent({ target }))).toBeNull();
    }
    expect(
      resolveShortcut(bindings, keyEvent({ target: { tagName: "BUTTON" } })),
    ).not.toBeNull();
  });

  it("never fires alongside browser modifiers", () => {
    expect(resolveShortcut(bindings, keyEvent({ metaKey: true }))).toBeNull();
    expect(resolveShortcut(bindings, keyEvent({ ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(bindings, keyEvent({ altKey: true }))).toBeNull();
  });

  it("suppresses every binding while a modal dialog is open", () => {
    for (const key of ["h", "[", "?"]) {
      expect(
        resolveShortcut(bindings, keyEvent({ key }), { modalOpen: true }),
      ).toBeNull();
    }
    expect(
      resolveShortcut(bindings, keyEvent({ key: "h" }), { modalOpen: false })
        ?.id,
    ).toBe("a");
  });

  it("suppresses character-key bindings when the WCAG 2.1.4 switch is off", () => {
    for (const key of ["h", "[", "?"]) {
      expect(
        resolveShortcut(bindings, keyEvent({ key }), {
          singleKeyDisabled: true,
        }),
      ).toBeNull();
    }
    // The switch only affects character keys; a hypothetical named-key
    // binding still resolves.
    const named: ShortcutBinding[] = [
      { id: "n", key: "F2", description: "Named", run: () => {} },
    ];
    expect(
      resolveShortcut(named, keyEvent({ key: "F2" }), {
        singleKeyDisabled: true,
      })?.id,
    ).toBe("n");
  });
});

describe("single-key shortcut preference persistence", () => {
  function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
    data: Map<string, string>;
  } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
    };
  }

  it("defaults to enabled and round-trips the disabled preference", () => {
    const storage = memoryStorage();
    expect(readSingleKeyShortcutsDisabled(storage)).toBe(false);
    writeSingleKeyShortcutsDisabled(true, storage);
    expect(storage.data.get(SINGLE_KEY_SHORTCUTS_STORAGE_KEY)).toBe("disabled");
    expect(readSingleKeyShortcutsDisabled(storage)).toBe(true);
    writeSingleKeyShortcutsDisabled(false, storage);
    expect(readSingleKeyShortcutsDisabled(storage)).toBe(false);
  });

  it("treats a missing or foreign stored value as enabled", () => {
    const storage = memoryStorage();
    storage.data.set(SINGLE_KEY_SHORTCUTS_STORAGE_KEY, "garbage");
    expect(readSingleKeyShortcutsDisabled(storage)).toBe(false);
    expect(readSingleKeyShortcutsDisabled(null)).toBe(false);
  });
});

describe("isModalOpen", () => {
  it("keys on aria-modal, so non-modal role=dialog floats do not suppress", () => {
    const modal = {
      querySelector: (selector: string) =>
        selector === '[aria-modal="true"]' ? {} : null,
    };
    const floatOnly = { querySelector: () => null };
    expect(isModalOpen(modal)).toBe(true);
    expect(isModalOpen(floatOnly)).toBe(false);
    expect(isModalOpen(null)).toBe(false);
  });
});

describe("createToolShortcuts", () => {
  it("binds every registered tool shortcut in rail order", () => {
    const activated: string[] = [];
    const toolBindings = createToolShortcuts((toolId) =>
      activated.push(toolId),
    );
    const expected = TOOL_DEFINITIONS.filter((tool) => tool.shortcut !== null);
    expect(toolBindings.map((binding) => binding.key)).toEqual(
      expected.map((tool) => tool.shortcut),
    );
    for (const binding of toolBindings) binding.run();
    expect(activated).toEqual(expected.map((tool) => tool.id));
  });

  it("registered tool keys resolve through the same suppression rules", () => {
    const toolBindings = createToolShortcuts(() => {});
    expect(resolveShortcut(toolBindings, keyEvent({ key: "v" }))?.id).toBe(
      "tool.select",
    );
    expect(
      resolveShortcut(
        toolBindings,
        keyEvent({ key: "v", target: { tagName: "INPUT" } }),
      ),
    ).toBeNull();
  });
});

describe("resolveModifierShortcut", () => {
  const modBindings = [
    { id: "edit.undo", key: "z", shift: false, description: "Undo", run: () => {} },
    { id: "edit.redo", key: "z", shift: true, description: "Redo", run: () => {} },
    { id: "project.save", key: "s", allowWhileTyping: true, description: "Save", run: () => {} },
  ];

  function modEvent(overrides: Partial<import("../../src/workspace/shortcuts").ModifierShortcutKeyEvent>) {
    return {
      key: "z",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      target: null,
      ...overrides,
    };
  }

  it("matches Ctrl/Cmd combos with exact shift state", () => {
    expect(resolveModifierShortcut(modBindings, modEvent({}))?.id).toBe("edit.undo");
    expect(
      resolveModifierShortcut(modBindings, modEvent({ shiftKey: true }))?.id,
    ).toBe("edit.redo");
    expect(
      resolveModifierShortcut(modBindings, modEvent({ ctrlKey: false, metaKey: true }))?.id,
    ).toBe("edit.undo");
    expect(
      resolveModifierShortcut(modBindings, modEvent({ ctrlKey: false })),
    ).toBeNull();
    expect(
      resolveModifierShortcut(modBindings, modEvent({ altKey: true })),
    ).toBeNull();
  });

  it("survives the character-key switch by construction but not modals", () => {
    expect(
      resolveModifierShortcut(modBindings, modEvent({}), { modalOpen: true }),
    ).toBeNull();
  });

  it("yields to native text editing unless allowWhileTyping", () => {
    expect(
      resolveModifierShortcut(
        modBindings,
        modEvent({ target: { tagName: "INPUT" } }),
      ),
    ).toBeNull();
    expect(
      resolveModifierShortcut(
        modBindings,
        modEvent({ key: "s", target: { tagName: "INPUT" } }),
      )?.id,
    ).toBe("project.save");
  });
});
