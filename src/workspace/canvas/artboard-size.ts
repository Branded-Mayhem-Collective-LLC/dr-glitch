/**
 * Custom artboard size validation — pure. Values arrive as the user typed
 * them, in the CURRENT display unit (px/in/mm); storage is always integer
 * document pixels at the fixed 240 DPI (unitToPx conversion, rounded).
 *
 * Guards: finite positive numbers, a minimum edge (degenerate artboards
 * make no press sheet), and the ResourcePolicy artboard pixel budget —
 * surfaced with the exact numbers so the Document drawer can show a
 * truthful message.
 */

import { RESOURCE_POLICY, type ResourcePolicy } from "../../core/resource-policy";
import type { UnitPreference } from "../../core/types";
import { unitToPx } from "../../editor";

/** Smallest accepted artboard edge (document px). */
export const MIN_ARTBOARD_EDGE_PX = 16;

export type ArtboardSizeResult =
  | { ok: true; widthPx: number; heightPx: number }
  | {
      ok: false;
      code: "invalid-number" | "too-small" | "exceeds-edge-budget" | "exceeds-pixel-budget";
      message: string;
    };

export function validateArtboardSize(
  widthValue: string | number,
  heightValue: string | number,
  unit: UnitPreference,
  policy: ResourcePolicy = RESOURCE_POLICY,
): ArtboardSizeResult {
  const width = typeof widthValue === "number" ? widthValue : Number(String(widthValue).trim());
  const height =
    typeof heightValue === "number" ? heightValue : Number(String(heightValue).trim());
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    String(widthValue).trim() === "" ||
    String(heightValue).trim() === ""
  ) {
    return {
      ok: false,
      code: "invalid-number",
      message: "Enter positive numbers for width and height.",
    };
  }
  const widthPx = Math.round(unitToPx(width, unit));
  const heightPx = Math.round(unitToPx(height, unit));
  if (widthPx < MIN_ARTBOARD_EDGE_PX || heightPx < MIN_ARTBOARD_EDGE_PX) {
    return {
      ok: false,
      code: "too-small",
      message: `Each side must be at least ${MIN_ARTBOARD_EDGE_PX} px (${unit} values convert to whole pixels at 240 DPI).`,
    };
  }
  if (widthPx > policy.maxArtboardEdge || heightPx > policy.maxArtboardEdge) {
    return {
      ok: false,
      code: "exceeds-edge-budget",
      message:
        `${widthPx} × ${heightPx} px exceeds the ` +
        `${policy.maxArtboardEdge.toLocaleString("en-US")} px maximum edge.`,
    };
  }
  const totalPixels = widthPx * heightPx;
  if (totalPixels > policy.maxArtboardPixels) {
    return {
      ok: false,
      code: "exceeds-pixel-budget",
      message:
        `${widthPx} × ${heightPx} px is ${totalPixels.toLocaleString("en-US")} pixels — ` +
        `over the ${policy.maxArtboardPixels.toLocaleString("en-US")} pixel artboard limit.`,
    };
  }
  return { ok: true, widthPx, heightPx };
}
