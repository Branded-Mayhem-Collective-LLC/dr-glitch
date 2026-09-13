/**
 * Permanent left tool rail — 52px wide, 44px targets, roving tabindex with
 * Arrow/Home/End (Enter/Space activate natively). Rail order comes straight
 * from TOOL_DEFINITIONS: tools group, separator, system group anchored at
 * the bottom. No placeholders for future tools.
 */

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "../components/icons";
import type {
  ToolCapabilityContext,
  ToolDefinition,
  ToolId,
} from "../core/types";
import {
  WORKSTATION_TOOLS,
  toolDisabledExplanation,
} from "./workstation-tool-registry";

const TOOL_DEFINITIONS = WORKSTATION_TOOLS.map((entry) => entry.definition);

type Props = {
  activeToolId: ToolId;
  capability: ToolCapabilityContext;
  onActivate: (toolId: ToolId) => void;
};

export function ToolRail({ activeToolId, capability, onActivate }: Props) {
  const tools = TOOL_DEFINITIONS;
  const buttonRefs = useRef(new Map<ToolId, HTMLButtonElement>());
  const [focusToolId, setFocusToolId] = useState<ToolId>(activeToolId);

  // Keep the roving stop valid even before the rail ever received focus.
  const rovingToolId = tools.some((tool) => tool.id === focusToolId)
    ? focusToolId
    : activeToolId;

  function focusTool(toolId: ToolId) {
    setFocusToolId(toolId);
    buttonRefs.current.get(toolId)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const index = tools.findIndex((tool) => tool.id === rovingToolId);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = (index + 1) % tools.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = (index - 1 + tools.length) % tools.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tools.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    focusTool(tools[next].id);
  }

  function renderTool(tool: ToolDefinition) {
    const enabled = tool.isEnabled ? tool.isEnabled(capability) : true;
    const explanation = toolDisabledExplanation(tool.id, capability);
    const active = tool.id === activeToolId;
    return (
      <button
        key={tool.id}
        ref={(node) => {
          if (node) buttonRefs.current.set(tool.id, node);
          else buttonRefs.current.delete(tool.id);
        }}
        type="button"
        className={`ws-rail-button ${active ? "is-active" : ""}`}
        data-testid={`ws-rail-${tool.id}`}
        tabIndex={tool.id === rovingToolId ? 0 : -1}
        aria-label={tool.label}
        aria-pressed={active}
        aria-current={active ? "true" : undefined}
        aria-disabled={enabled ? undefined : true}
        aria-keyshortcuts={tool.shortcut ?? undefined}
        /* Disabled tools explain WHY (capability truth), in both the
         * pointer tooltip and the accessible description. */
        aria-description={explanation ?? undefined}
        title={
          explanation
            ? `${tool.label} — ${explanation}`
            : tool.shortcut
              ? `${tool.label} (${tool.shortcut.toUpperCase()})`
              : tool.label
        }
        onFocus={() => setFocusToolId(tool.id)}
        onClick={() => {
          if (enabled) onActivate(tool.id);
        }}
      >
        <Icon name={tool.iconKey} size={19} />
      </button>
    );
  }

  return (
    <nav
      className="ws-rail"
      aria-label="Tools"
      data-testid="ws-rail"
      onKeyDown={onKeyDown}
    >
      <div className="ws-rail-group">
        {tools.filter((tool) => tool.group === "tools").map(renderTool)}
      </div>
      <div className="ws-rail-group ws-rail-group-system">
        <hr
          className="ws-rail-separator"
          data-testid="ws-rail-separator"
          role="separator"
          aria-orientation="horizontal"
        />
        {tools.filter((tool) => tool.group === "system").map(renderTool)}
      </div>
    </nav>
  );
}
