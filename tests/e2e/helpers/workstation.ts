import { expect, type Locator, type Page } from "@playwright/test";
import { bridgeNativeSavePicker } from "./save-picker";
import { resetAppStorage } from "./storage";

/**
 * Workstation selector contract helpers.
 *
 * Every locator produced here is part of the binding contract recorded in
 * docs/specs/2026-09-12-e2e-coverage-map.md. Accessible names come from the
 * tool registry (src/core/tool-registry.ts) and the workstation plan; stable
 * hooks use kebab-case data-testids with the "ws-" prefix.
 */

export const TOOL_LABELS = {
  select: "Select / Transform",
  layers: "Layers",
  halftone: "Halftone",
  diffusion: "Diffusion",
  glitch: "Glitch",
  plates: "Plates",
  history: "History / Snapshots",
  export: "Preflight / Export",
} as const;

export type WorkstationToolId = keyof typeof TOOL_LABELS;

/** Rail order per the workspace contract: tools group, separator, system group. */
export const RAIL_TOOL_GROUP: WorkstationToolId[] = [
  "select",
  "layers",
  "halftone",
  "diffusion",
  "glitch",
  "plates",
];
export const RAIL_SYSTEM_GROUP: WorkstationToolId[] = ["history", "export"];
export const RAIL_ORDER: WorkstationToolId[] = [
  ...RAIL_TOOL_GROUP,
  ...RAIL_SYSTEM_GROUP,
];

export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 520;
export const DOCK_DEFAULT_WIDTH = 360;
export const FLOAT_MIN_WIDTH = 320;
export const FLOAT_MIN_HEIGHT = 240;

/* ------------------------------------------------------------------ */
/* Chrome locators                                                     */
/* ------------------------------------------------------------------ */

export const topbar = (page: Page): Locator => page.getByTestId("ws-topbar");

export const topbarButton = (page: Page, name: string): Locator =>
  topbar(page).getByRole("button", { name, exact: true });

export const rail = (page: Page): Locator => page.getByTestId("ws-rail");

export const railButton = (page: Page, tool: WorkstationToolId): Locator =>
  rail(page).getByRole("button", { name: TOOL_LABELS[tool], exact: true });

export const railSeparator = (page: Page): Locator =>
  page.getByTestId("ws-rail-separator");

export const dock = (page: Page): Locator => page.getByTestId("ws-dock");

export const dockSplitter = (page: Page): Locator =>
  page.getByTestId("ws-dock-splitter");

/** A tool's sole panel instance, wherever it lives (dock or float). */
export const panel = (page: Page, tool: WorkstationToolId): Locator =>
  page.getByTestId(`ws-panel-${tool}`);

export const panelTitlebar = (page: Page, tool: WorkstationToolId): Locator =>
  page.getByTestId(`ws-panel-titlebar-${tool}`);

/** Floating window container for a tool's panel; absent while docked/closed. */
export const floatPanel = (page: Page, tool: WorkstationToolId): Locator =>
  page.getByTestId(`ws-float-${tool}`);

export const anyFloat = (page: Page): Locator =>
  page.locator('[data-testid^="ws-float-"]');

export const floatResizeHandle = (
  page: Page,
  tool: WorkstationToolId,
): Locator => floatPanel(page, tool).getByTestId("ws-float-resize-handle");

export type DrawerId = "document" | "proof" | "output";

export const DRAWER_LABELS: Record<DrawerId, string> = {
  document: "Document",
  proof: "Proof",
  output: "Output",
};

export const drawers = (page: Page): Locator => page.getByTestId("ws-drawers");

export const drawerToggle = (page: Page, id: DrawerId): Locator =>
  drawers(page).getByRole("button", { name: DRAWER_LABELS[id], exact: true });

export const drawer = (page: Page, id: DrawerId): Locator =>
  page.getByTestId(`ws-drawer-${id}`);

export const artboard = (page: Page): Locator => page.getByTestId("ws-artboard");

export const artboardCanvas = (page: Page): Locator =>
  page.getByTestId("ws-canvas");

export const sizeGate = (page: Page): Locator =>
  page.getByTestId("ws-size-gate");

export const statusRegion = (page: Page): Locator => page.getByRole("status");

export const projectTitle = (page: Page): Locator =>
  page.getByTestId("ws-project-title");

export const dirtyIndicator = (page: Page): Locator =>
  page.getByTestId("ws-dirty-indicator");

export const recoveryStatus = (page: Page): Locator =>
  page.getByTestId("ws-recovery-status");

export const recoveryBanner = (page: Page): Locator =>
  page.getByTestId("ws-recovery-banner");

export const readonlyBadge = (page: Page): Locator =>
  page.getByTestId("ws-readonly-badge");

/* ------------------------------------------------------------------ */
/* Home surface                                                        */
/* ------------------------------------------------------------------ */

export const homeSurface = (page: Page): Locator => page.getByTestId("ws-home");

export const projectCards = (page: Page): Locator =>
  page.getByTestId("ws-project-card");

export const projectCard = (page: Page, title: string | RegExp): Locator =>
  projectCards(page).filter({ hasText: title });

export async function openProjectCardMenu(
  page: Page,
  title: string | RegExp,
): Promise<Locator> {
  await projectCard(page, title)
    .getByRole("button", { name: "Project actions" })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

export const trashView = (page: Page): Locator => page.getByTestId("ws-trash");

/* ------------------------------------------------------------------ */
/* Panels: layers, history, export                                     */
/* ------------------------------------------------------------------ */

export const layerRows = (page: Page): Locator =>
  panel(page, "layers").getByTestId("ws-layer-row");

export const snapshotRows = (page: Page): Locator =>
  panel(page, "history").getByTestId("ws-snapshot-row");

export const preflightList = (page: Page): Locator =>
  page.getByTestId("ws-preflight-list");

export const exportPanel = (page: Page): Locator => panel(page, "export");

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

export type PanelMenuItem =
  | "Float"
  | "Dock Right"
  | "Close"
  | "Reset Position"
  | "Move"
  | "Resize";

export async function openPanelMenu(
  page: Page,
  tool: WorkstationToolId,
): Promise<Locator> {
  await panel(page, tool).getByRole("button", { name: "Panel menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

export async function choosePanelMenuItem(
  page: Page,
  tool: WorkstationToolId,
  item: PanelMenuItem,
): Promise<void> {
  const menu = await openPanelMenu(page, tool);
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
}

export type WorkspaceMenuItem = "Focus Mode" | "Lock Layout" | "Reset Layout";

export async function openWorkspaceMenu(page: Page): Promise<Locator> {
  await topbarButton(page, "Workspace").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Focus Mode / Lock Layout are menuitemcheckbox; Reset Layout is menuitem. */
export function workspaceMenuItem(menu: Locator, item: WorkspaceMenuItem): Locator {
  return menu
    .locator('[role="menuitem"], [role="menuitemcheckbox"]')
    .filter({ hasText: item });
}

export async function chooseWorkspaceMenuItem(
  page: Page,
  item: WorkspaceMenuItem,
): Promise<void> {
  const menu = await openWorkspaceMenu(page);
  await workspaceMenuItem(menu, item).click();
}

/* ------------------------------------------------------------------ */
/* Flows                                                               */
/* ------------------------------------------------------------------ */

/** Clean storage, land on the home surface. */
export async function gotoHome(page: Page): Promise<void> {
  await resetAppStorage(page);
  await expect(homeSurface(page)).toBeVisible();
}

/** Return to home from the editor via the topbar Home button. */
export async function goHome(page: Page): Promise<void> {
  await topbarButton(page, "Home").click();
  await expect(homeSurface(page)).toBeVisible();
}

export async function openSampleProject(page: Page): Promise<void> {
  await homeSurface(page)
    .getByRole("button", { name: "Open Sample", exact: true })
    .click();
  await expect(artboardCanvas(page)).toBeVisible();
}

export async function newProjectFromHome(page: Page): Promise<void> {
  await homeSurface(page)
    .getByRole("button", { name: "New Project", exact: true })
    .click();
  await expect(artboardCanvas(page)).toBeVisible();
}

/** Clean storage then open the bundled sample project (unsaved). */
export async function freshSampleProject(page: Page): Promise<void> {
  await bridgeNativeSavePicker(page);
  await gotoHome(page);
  await openSampleProject(page);
}

/* ------------------------------------------------------------------ */
/* Legacy-spec entry helpers (studio content, not just the shell)      */
/* ------------------------------------------------------------------ */

/**
 * Live proof canvas element (`<canvas data-testid="artwork-canvas">` inside
 * the artboard). Retained testid from the previous studio; the pixel-level
 * legacy specs snapshot it via toDataURL().
 */
export const proofCanvas = (page: Page): Locator =>
  page.getByTestId("artwork-canvas");

/** Hidden artwork file input behind the Select panel upload card / canvas drop.
 * Accept list per the artwork-intake contract: PNG, JPEG, static WebP, and
 * sanitized static SVG. */
export const artworkFileInput = (page: Page): Locator =>
  page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp,image/svg+xml"]');

/**
 * Hidden registration-mark SVG input behind the Export panel's
 * "Import registration SVG" button. Unique while the custom-shape dialog
 * (which uses the same accept string) is closed.
 */
export const registrationFileInput = (page: Page): Locator =>
  page.locator('input[type="file"][accept=".svg,image/svg+xml"]');

/** The Select panel upload card's <strong>, which names the artwork source. */
export const uploadCardName = (page: Page): Locator =>
  panel(page, "select").locator(".upload-card strong");

/**
 * Canonical entry for the migrated legacy specs: clean storage → home
 * surface → "Open Sample" (an unsaved project whose artwork is the bundled
 * demo artwork, i.e. createDemoArtwork encoded losslessly to PNG) → wait
 * for the first proof frame. The preview canvas keeps its default 300px
 * width until the renderer sizes it, so a larger width is the deterministic
 * "first render landed" signal the pixel-snapshot specs need.
 */
export async function openFreshStudio(page: Page): Promise<void> {
  await freshSampleProject(page);
  await expect(proofCanvas(page)).toBeVisible();
  await expect
    .poll(() =>
      proofCanvas(page).evaluate(
        (canvas) => (canvas as HTMLCanvasElement).width,
      ),
    )
    .toBeGreaterThan(300);
}

export type UploadFile = { name: string; mimeType: string; buffer: Buffer };

/**
 * Entry for specs that need their own artwork: fresh sample studio, then
 * replace the sample layer through the real upload path (the hidden file
 * input driven by the Select panel upload card). Resolves once the upload
 * card names the new source.
 */
export async function openStudioWithUpload(
  page: Page,
  file: UploadFile,
): Promise<void> {
  await openFreshStudio(page);
  await activateTool(page, "select");
  await artworkFileInput(page).setInputFiles(file);
  await expect(uploadCardName(page)).toHaveText(file.name);
}

/** Expand a drawer if collapsed (at most one drawer is ever expanded). */
export async function ensureDrawerExpanded(
  page: Page,
  id: DrawerId,
): Promise<void> {
  const toggle = drawerToggle(page, id);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(drawer(page, id)).toBeVisible();
}

/**
 * Explicit Save. The first save of a project opens the "Save Project" dialog
 * asking for a name; later saves are silent.
 */
export async function saveProjectAs(page: Page, name: string): Promise<void> {
  await topbarButton(page, "Save").click();
  const dialog = page.getByRole("dialog", { name: "Save Project" });
  await dialog.getByRole("textbox", { name: "Project name" }).fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(dirtyIndicator(page)).toBeHidden();
}

/**
 * Reload and land back in the named project's editor. The contract prefers
 * session restore (reload reopens the last open project, applying newer
 * recovery); a home landing is tolerated by reopening the Recent card.
 */
export async function reloadIntoProject(page: Page, title: string): Promise<void> {
  await page.reload();
  await expect(artboardCanvas(page).or(homeSurface(page))).toBeVisible();
  if (await homeSurface(page).isVisible()) {
    await projectCard(page, title).getByRole("button", { name: "Open" }).click();
  }
  await expect(artboardCanvas(page)).toBeVisible();
}

export async function activateTool(
  page: Page,
  tool: WorkstationToolId,
): Promise<void> {
  await railButton(page, tool).click();
  await expect(railButton(page, tool)).toHaveAttribute("aria-pressed", "true");
}

/** Activate a tool and float its panel via the titlebar menu. */
export async function floatTool(
  page: Page,
  tool: WorkstationToolId,
): Promise<Locator> {
  await activateTool(page, tool);
  await choosePanelMenuItem(page, tool, "Float");
  await expect(floatPanel(page, tool)).toBeVisible();
  return floatPanel(page, tool);
}

/**
 * A canonical undoable document edit that needs no layers: the cyan screen
 * angle in the Plates panel (which retains the "ink-chip-" and "ink-angle-"
 * testids from the current studio).
 */
export async function setCyanAngle(page: Page, value: string): Promise<void> {
  await activateTool(page, "plates");
  const angle = panel(page, "plates").getByTestId("ink-angle-cyan");
  await angle.fill(value);
  await angle.press("Enter");
  await expect(angle).toHaveValue(value);
}

export async function readCyanAngle(page: Page): Promise<string> {
  await activateTool(page, "plates");
  return panel(page, "plates").getByTestId("ink-angle-cyan").inputValue();
}

/* ------------------------------------------------------------------ */
/* Undo state                                                          */
/* ------------------------------------------------------------------ */

/**
 * Topbar Undo/Redo remain in the tab order when inert, so their state is
 * carried by aria-disabled, not the disabled attribute.
 */
export async function expectUndoState(page: Page, enabled: boolean): Promise<void> {
  await expect(topbarButton(page, "Undo")).toHaveAttribute(
    "aria-disabled",
    enabled ? "false" : "true",
  );
}

export async function expectRedoState(page: Page, enabled: boolean): Promise<void> {
  await expect(topbarButton(page, "Redo")).toHaveAttribute(
    "aria-disabled",
    enabled ? "false" : "true",
  );
}

/* ------------------------------------------------------------------ */
/* Geometry utilities                                                  */
/* ------------------------------------------------------------------ */

export type Box = { x: number; y: number; width: number; height: number };

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** Mouse-drag from the center of a locator by (dx, dy), in two move steps. */
export async function dragBy(
  page: Page,
  locator: Locator,
  dx: number,
  dy: number,
): Promise<void> {
  const box = await boxOf(locator);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx / 2, startY + dy / 2);
  await page.mouse.move(startX + dx, startY + dy);
  await page.mouse.up();
}
