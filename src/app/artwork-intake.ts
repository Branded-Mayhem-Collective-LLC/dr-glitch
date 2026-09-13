/**
 * Artwork intake intent — the pure command layer behind the two distinct
 * import flows:
 *
 * - REPLACE (Select panel upload card, canvas drop): the single-artwork
 *   convention — the layer that was PRIMARY when the picker opened is
 *   removed and the new layer takes its stack position. The intent captures
 *   that target id IMMUTABLY at request time, so two racing intakes can
 *   never tear state (latest global request wins; each carries its own
 *   frozen intent).
 * - ADD (Layers panel "Add Layer"): preserves every existing layer and the
 *   artboard, appends the new layer on top (created SELECTED by the caller,
 *   Clean mode, Glitch off), and enforces the layer cap with a clear error
 *   instead of a silent reducer no-op.
 *
 * Pure and DOM-free: unit-testable in Node.
 */

import { RESOURCE_POLICY } from "../core/resource-policy";
import type { Id, LayerV1, ProjectCoreV1 } from "../core/types";
import type { Command } from "../project";

export type ArtworkIntakeIntent =
  | { mode: "replace"; targetLayerId: Id | null }
  | { mode: "add" };

export type ArtworkIntakeResult =
  | { ok: true; commands: Command[] }
  | { ok: false; error: string };

export function layerCapError(): string {
  return `Projects hold at most ${RESOURCE_POLICY.maxLayers} layers. Delete a layer before adding another.`;
}

/**
 * Stack commands for one validated intake against the CURRENT core.
 * `layer` is the fully-built new layer (id, asset, transform, recipe).
 *
 * Replace whose captured target has left the document degrades to a plain
 * add (subject to the cap) — the operator's file must never be dropped
 * because the stack changed underneath the picker.
 */
export function artworkIntakeCommands(
  core: ProjectCoreV1,
  intent: ArtworkIntakeIntent,
  layer: LayerV1,
): ArtworkIntakeResult {
  if (intent.mode === "replace" && intent.targetLayerId !== null) {
    const index = core.layers.findIndex(
      (candidate) => candidate.id === intent.targetLayerId,
    );
    if (index >= 0) {
      return {
        ok: true,
        commands: [
          { type: "layer/remove", layerId: intent.targetLayerId },
          { type: "layer/add", layer, index },
        ],
      };
    }
  }
  if (core.layers.length >= RESOURCE_POLICY.maxLayers) {
    return { ok: false, error: layerCapError() };
  }
  return { ok: true, commands: [{ type: "layer/add", layer }] };
}
