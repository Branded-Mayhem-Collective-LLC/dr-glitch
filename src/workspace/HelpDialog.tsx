/**
 * Help dialog — searchable reference for shortcuts, gestures, tool effects,
 * and production consequences. Two live sources, so it can never drift
 * silently from what the product actually does:
 * - the shortcut registry passed in by the shell (the keys as bound), plus
 *   a curated gesture list;
 * - the full searchable Help corpus (src/help): substantive topics on tool
 *   effects ("Floyd-Steinberg", "macroblock", "skew", "perspective", …)
 *   and production consequences, matched through src/help's searchHelp.
 *
 * Modality (scrim, inert background, focus trap, focus restoration) comes
 * from ModalDialog; the shell's openHelp/closeHelp pair captures the
 * invoker so Escape returns focus deterministically even when Help was
 * opened with the "?" shortcut.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/icons";
import {
  HELP_CATEGORY_LABELS,
  HELP_TOPICS,
  searchHelp,
  type HelpTopic,
} from "../help";
import { ModalDialog } from "./ModalDialog";
import type { ShortcutBinding } from "./shortcuts";

type HelpRow = {
  keys: string;
  description: string;
};

const GESTURE_ROWS: HelpRow[] = [
  { keys: "Space + drag", description: "Pan the proof without changing artwork." },
  { keys: "Drag panel titlebar", description: "Move a floating panel — or drag a DOCKED titlebar to pop it out; drop a float on the right dock to re-dock it (Escape cancels)." },
  { keys: "Drag panel edges", description: "Resize a floating panel, minimum 320×240." },
  { keys: "Alt-click ink chip", description: "Toggle plate visibility — hidden plates print nothing." },
  { keys: "Drag angle dial", description: "Rotate a plate's screen angle. Shared angles risk moiré." },
  { keys: "Arrow keys on rail", description: "Move between tools; Enter or Space activates." },
  { keys: "Arrow keys on splitter", description: "Resize the tool dock (320–520px)." },
  { keys: "Panel menu → Move / Resize", description: "Keyboard move/resize: arrows step 16px, Shift steps 1px, Enter commits, Escape cancels." },
];

type Props = {
  shortcuts: readonly ShortcutBinding[];
  onClose: () => void;
};

export function HelpDialog({ shortcuts, onClose }: Props) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const needle = query.trim().toLowerCase();

  const rows = useMemo(() => {
    const shortcutRows: Array<HelpRow & { section: string }> = shortcuts.map(
      (binding) => ({
        keys: binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
        description: binding.description,
        section: "Shortcuts",
      }),
    );
    const all = [
      ...shortcutRows,
      ...GESTURE_ROWS.map((row) => ({ ...row, section: "Gestures" })),
    ];
    if (!needle) return all;
    return all.filter(
      (row) =>
        row.keys.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle) ||
        row.section.toLowerCase().includes(needle),
    );
  }, [shortcuts, needle]);

  const sections = useMemo(() => {
    const grouped = new Map<string, HelpRow[]>();
    for (const row of rows) {
      const section = (row as HelpRow & { section: string }).section;
      grouped.set(section, [...(grouped.get(section) ?? []), row]);
    }
    return [...grouped.entries()];
  }, [rows]);

  /** The real Help corpus: tool effects + production consequences etc. */
  const topics = useMemo<HelpTopic[]>(() => {
    if (!needle) return HELP_TOPICS;
    return searchHelp(HELP_TOPICS, query).map((result) => result.topic);
  }, [needle, query]);

  return (
    <ModalDialog scrimClassName="ws-help-backdrop" onBackdropPointerDown={onClose}>
      <div
        className="ws-help"
        role="dialog"
        aria-modal="true"
        aria-label="Help — shortcuts and gestures"
        data-testid="help-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="ws-help-header">
          <strong>Help</strong>
          <button
            type="button"
            className="ws-titlebar-button"
            aria-label="Close help"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <label className="ws-help-search">
          <span className="sr-only">Search help</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search shortcuts, gestures, tools, consequences…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="ws-help-body">
          {sections.length === 0 && topics.length === 0 && (
            <p className="control-state-note">No matches. Try fewer letters.</p>
          )}
          {sections.map(([section, sectionRows]) => (
            <section key={section}>
              <h3>{section}</h3>
              <dl>
                {sectionRows.map((row) => (
                  <div key={`${section}-${row.keys}-${row.description}`}>
                    <dt>{row.keys}</dt>
                    <dd>{row.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {topics.length > 0 && (
            <section aria-label="Topics">
              <h3>Topics</h3>
              {topics.map((topic, index) => (
                <details
                  key={topic.id}
                  data-testid="help-topic"
                  /* A search opens its best match so the answer is readable
                     immediately; browsing keeps topics collapsed. */
                  open={Boolean(needle) && index === 0}
                >
                  <summary>
                    {topic.title}
                    <span className="ws-help-topic-category">
                      {" — "}
                      {HELP_CATEGORY_LABELS[topic.category]}
                    </span>
                  </summary>
                  {topic.body.split(/\n{2,}/).map((paragraph) => (
                    <p key={paragraph.slice(0, 40)}>{paragraph}</p>
                  ))}
                </details>
              ))}
            </section>
          )}
        </div>
        <footer className="ws-help-footer">
          Projects and artwork stay on this device. Accounts never sync files.
        </footer>
      </div>
    </ModalDialog>
  );
}
