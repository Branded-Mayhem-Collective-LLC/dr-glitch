import type { Plate } from "./halftone";

/**
 * Spec §3 process inks, for CHROME ONLY.
 *
 * These are deliberately NOT the engine's PLATE_META colors. halftone.ts is an
 * outside collaborator's GPL work, out of scope, and pinned by a render hash
 * gate — its colors are render values and must never be changed to match these.
 * Screen primaries such as #00FFFF are banned by §3: they read as RGB and
 * undermine the product's credibility with press people.
 */
export const CHROME_INK: Record<Exclude<Plate, "composite">, string> = {
  cyan: "#0093D0",
  magenta: "#E6007E",
  yellow: "#FFE800",
  black: "#101010",
};

/** Composite presents all four inks, so it carries no single plate hue (§6.2). */
export const COMPOSITE_INK = "#101010";
