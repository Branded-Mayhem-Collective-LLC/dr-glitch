/**
 * WorkstationToolRegistry — THE single declaration binding each core
 * ToolDefinition (pure data in src/core/tool-registry) to its workspace
 * panel component, chrome copy, activation behavior, and capability
 * messaging. The rail, the shell, and the panel chrome all consume this
 * registry; nothing else re-declares the tool ↔ panel contract.
 *
 * Activation behavior (implemented by workspaceReducer "activate-tool",
 * invoked through `entry.activate`): a tool's SOLE panel is revealed in the
 * right dock, displacing the previous dock panel — unless its remembered
 * placement is floating, in which case the existing float is raised in
 * place with its remembered rect.
 */

import type { ComponentType } from "react";
import { TOOL_DEFINITIONS } from "../core/tool-registry";
import type {
  ToolCapabilityContext,
  ToolDefinition,
  ToolId,
} from "../core/types";
import { DiffusionPanel } from "./panels/DiffusionPanel";
import { ExportPanel } from "./panels/ExportPanel";
import { GlitchPanel } from "./panels/GlitchPanel";
import { HalftonePanel } from "./panels/HalftonePanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { LayersPanel } from "./panels/LayersPanel";
import { PlatesPanel } from "./panels/PlatesPanel";
import { SelectPanel } from "./panels/SelectPanel";

export type WorkstationToolEntry = {
  /** The core registry row — id, label, icon, shortcut, group, isEnabled. */
  definition: ToolDefinition;
  /** Panel chrome title (equals the tool label by contract). */
  title: string;
  description: string;
  /** The tool's sole panel component; one instance ever mounted. */
  Component: ComponentType;
  /**
   * Rail/shortcut activation: reveal the panel per the remembered
   * placement (dock, or raise the float). One line so behavior stays a
   * declaration, not scattered wiring.
   */
  activate: (controller: { activateTool: (toolId: ToolId) => void }) => void;
  /**
   * Operator-facing explanation surfaced (title/aria-description) when
   * definition.isEnabled(context) is false. Null when the tool has no
   * capability gate.
   */
  disabledExplanation: string | null;
};

type PanelBinding = {
  description: string;
  Component: ComponentType;
  disabledExplanation: string | null;
};

const PANEL_BINDINGS: Record<ToolId, PanelBinding> = {
  select: {
    description: "Artwork source and sheet placement.",
    Component: SelectPanel,
    disabledExplanation: null,
  },
  layers: {
    description: "The artwork stack.",
    Component: LayersPanel,
    disabledExplanation: null,
  },
  halftone: {
    description: "Dot geometry used by halftone mode.",
    Component: HalftonePanel,
    disabledExplanation: "Unavailable until a project is open.",
  },
  diffusion: {
    description: "Error-diffusion texture controls.",
    Component: DiffusionPanel,
    disabledExplanation: "Unavailable until a project is open.",
  },
  glitch: {
    description: "Slice, warp, smear, corrupt, and sort.",
    Component: GlitchPanel,
    disabledExplanation: "Unavailable until a project is open.",
  },
  plates: {
    description: "Separation, visibility, and screen angles.",
    Component: PlatesPanel,
    disabledExplanation: null,
  },
  history: {
    description: "Session history and checkpoints.",
    Component: HistoryPanel,
    disabledExplanation: null,
  },
  export: {
    description: "Output finishing and press handoff.",
    Component: ExportPanel,
    disabledExplanation: null,
  },
};

/** Rail order comes straight from the core registry array order. */
export const WORKSTATION_TOOLS: WorkstationToolEntry[] = TOOL_DEFINITIONS.map(
  (definition) => ({
    definition,
    title: definition.label,
    description: PANEL_BINDINGS[definition.id].description,
    Component: PANEL_BINDINGS[definition.id].Component,
    activate: (controller) => controller.activateTool(definition.id),
    disabledExplanation: PANEL_BINDINGS[definition.id].disabledExplanation,
  }),
);

export const WORKSTATION_TOOL_REGISTRY: Record<ToolId, WorkstationToolEntry> =
  Object.fromEntries(
    WORKSTATION_TOOLS.map((entry) => [entry.definition.id, entry]),
  ) as Record<ToolId, WorkstationToolEntry>;

export function isToolEnabled(
  toolId: ToolId,
  context: ToolCapabilityContext,
): boolean {
  const { definition } = WORKSTATION_TOOL_REGISTRY[toolId];
  return definition.isEnabled ? definition.isEnabled(context) : true;
}

/** Explanation for a disabled tool, or null when it is available. */
export function toolDisabledExplanation(
  toolId: ToolId,
  context: ToolCapabilityContext,
): string | null {
  if (isToolEnabled(toolId, context)) return null;
  return (
    WORKSTATION_TOOL_REGISTRY[toolId].disabledExplanation ??
    "Unavailable in the current context."
  );
}
