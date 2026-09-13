import type { ToolDefinition, ToolId } from "./types";

/**
 * Canonical tool DATA — the pure (React-free, DOM-free) half of the ONE
 * unified tool registry. Every tool's id, label, icon key, shortcut,
 * group, panel key, and capability gate is declared exactly once, here.
 *
 * The workspace side (src/workspace/workstation-tool-registry.tsx) binds
 * each row to its panel component, chrome copy, and activation behavior;
 * nothing else re-declares any part of the tool ↔ panel contract. Rail
 * order is this array's order: tools group first, a separator, then the
 * system group. No placeholders for future tools.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: "select",
    label: "Select / Transform",
    iconKey: "select",
    shortcut: "v",
    group: "tools",
    panelKey: "select",
  },
  {
    id: "layers",
    label: "Layers",
    iconKey: "layers",
    shortcut: "l",
    group: "tools",
    panelKey: "layers",
  },
  {
    id: "halftone",
    label: "Halftone",
    iconKey: "halftone",
    shortcut: "h",
    group: "tools",
    panelKey: "halftone",
    isEnabled: (context) => context.hasProject,
  },
  {
    id: "diffusion",
    label: "Diffusion",
    iconKey: "diffusion",
    shortcut: "d",
    group: "tools",
    panelKey: "diffusion",
    isEnabled: (context) => context.hasProject,
  },
  {
    id: "glitch",
    label: "Glitch",
    iconKey: "glitch",
    shortcut: "g",
    group: "tools",
    panelKey: "glitch",
    isEnabled: (context) => context.hasProject,
  },
  {
    id: "plates",
    label: "Plates",
    iconKey: "plates",
    shortcut: "p",
    group: "tools",
    panelKey: "plates",
  },
  {
    id: "history",
    label: "History / Snapshots",
    iconKey: "history",
    shortcut: "y",
    group: "system",
    panelKey: "history",
  },
  {
    id: "export",
    label: "Preflight / Export",
    iconKey: "export",
    shortcut: "e",
    group: "system",
    panelKey: "export",
  },
];

const byId = new Map<ToolId, ToolDefinition>(
  TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

export function getToolDefinition(id: ToolId): ToolDefinition {
  const tool = byId.get(id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
