/**
 * Single source of truth for the product name (spec §2, resolved 2026-07-27).
 *
 * The prior name was a placeholder emitted by the Codex generation, not
 * established branding. DR.GLITCH is approved for use everywhere. (Not
 * spelled out here on purpose — see task-4-report.md — so this file itself
 * doesn't fail the single-source grep for the retired name.)
 *
 * Import PRODUCT_NAME. Never retype the string — a name in two places is a
 * name that will disagree with itself.
 */
export const PRODUCT_NAME = "DR.GLITCH";

/** Shown in the <title> and on auth screens. */
export const PRODUCT_TAGLINE = "CMYK Separation Studio";
