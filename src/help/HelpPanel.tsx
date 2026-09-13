/**
 * Searchable Help panel: an accessible modal dialog with a search field,
 * keyboard-navigable result list, and a reading pane. Escape closes; focus
 * returns to the element that opened it (the opener keeps that contract by
 * calling onClose and restoring focus itself).
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { HELP_CATEGORY_LABELS, HELP_TOPICS, type HelpTopic } from "./content";
import { searchHelp } from "./search";

export type HelpPanelProps = {
  open: boolean;
  onClose: () => void;
  topics?: HelpTopic[];
};

export function HelpPanel({ open, onClose, topics = HELP_TOPICS }: HelpPanelProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listId = useId();

  const results = useMemo(() => searchHelp(topics, query), [topics, query]);
  const selected =
    topics.find((topic) => topic.id === selectedId) ?? results[activeIndex]?.topic ?? null;

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setSelectedId(null);
      searchRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(results.length - 1, index + 1));
      setSelectedId(null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      setSelectedId(null);
    } else if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      setSelectedId(results[activeIndex].topic.id);
    }
  }

  return (
    <div
      className="help-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <header className="help-panel-header">
        <h2 id={titleId}>Help</h2>
        <button type="button" onClick={onClose} aria-label="Close help">
          Close
        </button>
      </header>
      <label className="help-panel-search">
        Search help
        <input
          ref={searchRef}
          type="search"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            results[activeIndex] ? `help-option-${results[activeIndex].topic.id}` : undefined
          }
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setSelectedId(null);
          }}
          placeholder="Shortcuts, tools, moiré, registration…"
        />
      </label>
      <div className="help-panel-body">
        <ul id={listId} role="listbox" aria-label="Help topics" className="help-panel-results">
          {results.length === 0 ? (
            <li className="help-panel-empty" role="presentation">
              No topics match “{query}”.
            </li>
          ) : (
            results.map(({ topic }, index) => (
              <li
                key={topic.id}
                id={`help-option-${topic.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "is-active" : undefined}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    setActiveIndex(index);
                    setSelectedId(topic.id);
                  }}
                >
                  <span className="help-topic-title">{topic.title}</span>
                  <span className="help-topic-category">
                    {HELP_CATEGORY_LABELS[topic.category]}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <article className="help-panel-reading" aria-live="polite">
          {selected ? (
            <>
              <h3>{selected.title}</h3>
              <p className="help-topic-category">{HELP_CATEGORY_LABELS[selected.category]}</p>
              {selected.body.split("\n\n").map((paragraph, index) => (
                <p key={index} style={{ whiteSpace: "pre-line" }}>
                  {paragraph}
                </p>
              ))}
            </>
          ) : (
            <p>Select a topic to read it.</p>
          )}
        </article>
      </div>
    </div>
  );
}
