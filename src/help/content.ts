/**
 * Searchable Help content. Topics are functional product documentation for
 * the tools that exist today — no placeholders. Shortcut listings are
 * generated from the canonical tool registry so Help never drifts from the
 * real bindings.
 */

import { TOOL_DEFINITIONS } from "../core/tool-registry";

export type HelpCategory = "shortcuts" | "gestures" | "tools" | "production";

export type HelpTopic = {
  id: string;
  title: string;
  category: HelpCategory;
  keywords: string[];
  /** Plain-text body; paragraphs separated by blank lines. */
  body: string;
};

export const HELP_CATEGORY_LABELS: Record<HelpCategory, string> = {
  shortcuts: "Keyboard shortcuts",
  gestures: "Mouse and gestures",
  tools: "Tool effects",
  production: "Production consequences",
};

function toolShortcutLines(): string {
  return TOOL_DEFINITIONS.map((tool) =>
    tool.shortcut
      ? `${tool.shortcut.toUpperCase()} — ${tool.label}`
      : `(no shortcut) — ${tool.label}`,
  ).join("\n");
}

export const HELP_TOPICS: HelpTopic[] = [
  /* ------------------------------------------------------------ */
  /* Shortcuts                                                     */
  /* ------------------------------------------------------------ */
  {
    id: "shortcuts-tools",
    title: "Tool shortcuts",
    category: "shortcuts",
    keywords: ["keyboard", "keys", "rail", "tool", "switch", "select"],
    body:
      "Press a tool key to activate that tool and show its panel in the right dock:\n\n" +
      toolShortcutLines() +
      "\n\nSingle-key shortcuts are suppressed while you are typing in a text field, " +
      "so names and numeric entries never trigger tools.",
  },
  {
    id: "shortcuts-editing",
    title: "Editing shortcuts",
    category: "shortcuts",
    keywords: ["undo", "redo", "save", "escape", "cancel", "ctrl", "cmd"],
    body:
      "Ctrl/Cmd+Z — Undo the last transaction (up to 100 per session).\n" +
      "Ctrl/Cmd+Shift+Z — Redo.\n" +
      "Ctrl/Cmd+S — Save the project locally on this device.\n" +
      "Escape — Cancel the drag, scrub, crop, transform, or panel move in progress " +
      "without committing a history transaction.\n\n" +
      "Undo covers layers, transforms, recipes, artboard and global settings, guides, " +
      "and registration. It never covers selection, active tool, zoom, pan, or panel layout.",
  },
  {
    id: "shortcuts-workspace",
    title: "Workspace and panel shortcuts",
    category: "shortcuts",
    keywords: ["panel", "dock", "float", "focus", "arrow", "rail", "navigate"],
    body:
      "The left tool rail is keyboard navigable: Arrow keys move between tools, " +
      "Home/End jump to the first or last tool, and Enter or Space activates the " +
      "focused tool. Panel menus offer Float, Dock Right, Close, Reset Position, " +
      "Move, and Resize as keyboard commands; Escape cancels a keyboard move or resize.",
  },

  /* ------------------------------------------------------------ */
  /* Gestures                                                      */
  /* ------------------------------------------------------------ */
  {
    id: "gestures-selection",
    title: "Selecting layers",
    category: "gestures",
    keywords: ["click", "shift", "multi", "selection", "primary"],
    body:
      "Click a layer to select it. Shift-click or Ctrl/Cmd-click adds or removes " +
      "layers from the selection. The last layer you selected is the primary layer: " +
      "recipe edits apply only to the primary layer unless you explicitly use " +
      "Copy Recipe, Apply to Selected, or a preset. Group transforms move every " +
      "selected unlocked layer together.",
  },
  {
    id: "gestures-panels",
    title: "Moving and docking panels",
    category: "gestures",
    keywords: ["drag", "titlebar", "float", "dock", "resize", "close"],
    body:
      "Drag a panel's titlebar to float it anywhere inside the app window. Drag it " +
      "onto the right dock to dock it; docking into an occupied dock hides the " +
      "displaced panel. Each tool has one panel instance. Closing a panel remembers " +
      "its placement; activating the tool from the rail restores it. Floats have a " +
      "320 by 240 minimum and recovered floats are clamped so the titlebar stays reachable.",
  },
  {
    id: "gestures-guides",
    title: "Rulers, guides, and snapping",
    category: "gestures",
    keywords: ["ruler", "guide", "grid", "snap", "drag", "smart"],
    body:
      "Drag from a ruler to place a guide; drag a guide off the artboard to remove it. " +
      "Guides can be locked and cleared from the Document drawer, persist with the " +
      "project, and are undoable — but they never appear in any export. Snapping can " +
      "target guides, the grid, other layers, and the artboard edges and center.",
  },

  /* ------------------------------------------------------------ */
  /* Tools                                                         */
  /* ------------------------------------------------------------ */
  {
    id: "tool-halftone",
    title: "Halftone: cells, angles, and dot shapes",
    category: "tools",
    keywords: [
      "halftone", "cell", "cell size", "dot", "shape", "angle", "screen",
      "round", "square", "diamond", "line", "triangle", "cross", "outline", "custom", "svg",
    ],
    body:
      "Halftone converts tone into a screen of dots. Cell size sets the screen pitch " +
      "in document pixels: smaller cells hold more detail but print finer dots. Dot " +
      "shapes are round, square, diamond, line, triangle, cross, circle outline, or a " +
      "custom SVG shape you import. Dot size follows the square root of ink coverage, " +
      "so midtones read correctly.\n\n" +
      "Screen angles are document-global and anchored to the artboard center: the " +
      "conventional set is cyan 15°, magenta 75°, yellow 0°, black 45°. Moving or " +
      "warping artwork never moves the screen lattice, so layered art stays on one " +
      "consistent screen. Invert flips coverage for printing negatives or light-on-dark art.",
  },
  {
    id: "tool-diffusion",
    title: "Diffusion: error-diffusion dithering",
    category: "tools",
    keywords: [
      "diffusion", "dither", "floyd", "steinberg", "jarvis", "stucki", "burkes",
      "atkinson", "levels", "intensity", "modulation", "sharpen", "denoise",
    ],
    body:
      "Diffusion renders tone as scattered pixels using error-diffusion dithering. " +
      "Algorithms trade texture against fidelity: Floyd-Steinberg is the classic " +
      "fine-grain default; Jarvis-Judice-Ninke and Stucki spread error further for " +
      "smoother gradients; Burkes is a faster two-row variant; Atkinson diffuses only " +
      "three quarters of the error for a bright, high-contrast look.\n\n" +
      "Levels sets how many tones each channel quantizes to. Intensity scales how much " +
      "error propagates. Modulation overlays structural patterns (column, row, " +
      "dispersed, circuit, tilt, grid). Sharpen, denoise, broken kernel, directional " +
      "bias, error overflow, reset, and cross-channel bleed intentionally distress the " +
      "diffusion for expressive texture.",
  },
  {
    id: "tool-glitch",
    title: "Glitch effects",
    category: "tools",
    keywords: [
      "glitch", "slice", "shift", "warp", "smear", "macroblock", "corrupt",
      "dropout", "block", "channel", "desync", "bitmap sort", "datamosh",
    ],
    body:
      "Glitch distorts the coverage field before dots or diffusion are placed, so " +
      "every plate inherits the same corruption. Slice shift displaces horizontal " +
      "bands; vertical slice shift does the same for columns. Grid warp bends the " +
      "sampling lattice, smear drags pixels along a direction, macroblock corrupt and " +
      "dropout simulate compression damage, block shift scrambles tiles, channel " +
      "desync offsets each plate separately, and bitmap sort reorders runs of bright " +
      "pixels like classic pixel-sorting.\n\n" +
      "Glitch is deterministic: the same settings always produce the same result, in " +
      "preview and in export. New assets start clean with Glitch off.",
  },
  {
    id: "tool-layers",
    title: "Layers, transforms, and crop",
    category: "tools",
    keywords: [
      "layer", "stack", "opacity", "visibility", "lock", "crop", "transform",
      "rotate", "scale", "skew", "flip", "perspective",
    ],
    body:
      "A project is a flat, ordered stack of up to 32 layers. Each layer has " +
      "visibility, lock, one normal opacity, a non-destructive crop, and a decomposed " +
      "transform: position, scale, rotation, flips, skew, and a free convex " +
      "four-corner perspective. Each layer keeps its own recipe — clean, halftone, or " +
      "diffusion mode plus all three setting groups — and switching mode never " +
      "discards the inactive settings. Duplicate Layer copies the full recipe.",
  },
  {
    id: "tool-plates",
    title: "Plates and separation",
    category: "tools",
    keywords: ["plate", "cmyk", "grayscale", "separation", "angle", "visibility", "proof"],
    body:
      "The Plates tool owns document-global separation: CMYK builds four process " +
      "plates from the composite; grayscale builds a single black plate from " +
      "luminance. Plate visibility hides a plate everywhere — proof and export alike. " +
      "Screen angles live here too, shared by every layer, so the whole document " +
      "prints on one coherent screen set. The Proof drawer previews the composite or " +
      "any single plate with a live registration overlay.",
  },

  /* ------------------------------------------------------------ */
  /* Production                                                    */
  /* ------------------------------------------------------------ */
  {
    id: "production-registration",
    title: "Registration marks",
    category: "production",
    keywords: ["registration", "marks", "alignment", "press", "corners", "centered"],
    body:
      "Registration marks let a printer align plates on press. They default ON for " +
      "plate packages — plates without registration cannot be aligned — and OFF for " +
      "composite and selected-layer exports, where they would print inside the " +
      "artwork. Both defaults are overridable per export. Marks can sit in the four " +
      "corners or centered top and bottom, and a sanitized custom SVG can replace the " +
      "default crosshair.",
  },
  {
    id: "production-polarity",
    title: "Polarity: positive and negative",
    category: "production",
    keywords: ["polarity", "positive", "negative", "invert", "film", "emulsion"],
    body:
      "Positive output prints ink where the artwork is dark — the normal case for " +
      "direct printing. Negative output inverts ink and open area at export, for " +
      "film-positive workflows, screen-exposure films, or plate processes that expect " +
      "a negative. Exporting a negative by accident produces unusable film, so " +
      "preflight asks you to confirm negative polarity every time the project changes.",
  },
  {
    id: "production-press-mirror",
    title: "Press mirror",
    category: "production",
    keywords: ["mirror", "flip", "emulsion", "wrong-reading", "right-reading"],
    body:
      "Press mirror flips output horizontally so film reads correctly emulsion-down " +
      "on the plate or screen. Use it when your exposure workflow needs wrong-reading " +
      "film; leave it off for right-reading digital output. A mirrored proof looks " +
      "backwards on screen by design — check the Output drawer rather than trusting " +
      "the on-screen orientation.",
  },
  {
    id: "production-angles-moire",
    title: "Screen angles and moiré",
    category: "production",
    keywords: ["moire", "moiré", "angle", "interference", "rosette", "pattern"],
    body:
      "When two halftone screens sit at nearly the same angle, their lattices " +
      "interfere and print a visible moiré pattern. The conventional CMYK set " +
      "(C 15°, M 75°, Y 0°, K 45°) separates the strong plates by 30° and produces a " +
      "clean rosette. Deviating can be a deliberate effect, but preflight warns about " +
      "unusual or duplicate angles because moiré often only becomes obvious at press " +
      "resolution.",
  },
  {
    id: "production-vector-plates",
    title: "Vector plates and eligibility",
    category: "production",
    keywords: ["vector", "svg", "plate", "eligible", "raster", "clean", "continuous"],
    body:
      "An SVG plate package contains genuine vector marks — halftone dots as shapes " +
      "and diffusion as coalesced runs — which rip cleanly at any output resolution. " +
      "A clean continuous-tone layer has no vector representation: it can export " +
      "raster plates, but it disables vector plates for the whole document. DR.GLITCH " +
      "never hides raster data inside a file that claims to be vector.",
  },
  {
    id: "production-resolution",
    title: "Resolution and 240 DPI",
    category: "production",
    keywords: ["dpi", "resolution", "240", "size", "inches", "pixels", "metadata"],
    body:
      "Documents are fixed at 240 DPI: geometry is stored as integer document pixels, " +
      "and px/in/mm are display preferences that convert exactly. Exported PNG and " +
      "TIFF files carry 240-DPI metadata so prepress software opens them at true " +
      "physical size. An artboard smaller than its press preset prints smaller than " +
      "the expected sheet — preflight flags this before export.",
  },
  {
    id: "production-opacity",
    title: "Opacity on press",
    category: "production",
    keywords: ["opacity", "transparent", "alpha", "coverage", "knockout", "ink"],
    body:
      "Layer opacity multiplies ink coverage exactly once: a 50% opaque layer " +
      "halftones as 50% lighter coverage on every plate. Transparent areas of an " +
      "upper layer reveal the ink below; fully opaque zero-ink areas knock out the " +
      "ink underneath. The artboard background is a proof and matte preference only — " +
      "it never creates plate ink.",
  },
  {
    id: "production-preflight",
    title: "Preflight: blocks and warnings",
    category: "production",
    keywords: ["preflight", "block", "warning", "confirm", "export", "check"],
    body:
      "Preflight runs before every export. Blocking issues — missing or corrupt " +
      "assets, invalid transforms, unsafe SVG, impossible output, or work beyond the " +
      "resource limits — stop the export until fixed. Warnings — unusual angles, " +
      "negative polarity, hidden layers or plates, registration defaults overridden, " +
      "press-readiness concerns — require confirmation, and that confirmation is " +
      "bound to the project revision: change the project and the warnings ask again.",
  },
];

export function getHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}
