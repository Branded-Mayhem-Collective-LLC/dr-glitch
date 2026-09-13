/**
 * Browser sample-artwork factory for the unsaved sample project.
 *
 * The sample ships as a pre-generated PNG asset (sample-artwork.png) rather
 * than being canvas-encoded at click time: `canvas.toBlob("image/png")` runs
 * on Chromium's idle-task encoder, which can starve for ~6.6s (the encoder's
 * fail-safe timeout) when the renderer produces no frames — e.g. headless
 * browsers — making "Open Sample" pathologically slow. The asset was
 * generated from createDemoArtwork (src/studio/halftone.ts) in Chromium and
 * is pixel-identical to the live-drawn artwork (verified channel-by-channel),
 * so every render oracle downstream is unaffected. If createDemoArtwork
 * changes, regenerate the PNG from it.
 */
import { PRODUCT_NAME } from "../brand";
import type { SampleArtwork } from "./session-controller";
import sampleArtworkUrl from "./sample-artwork.png";

export const SAMPLE_ARTWORK_WIDTH = 1200;
export const SAMPLE_ARTWORK_HEIGHT = 900;

export async function createSampleArtwork(): Promise<SampleArtwork> {
  const response = await fetch(sampleArtworkUrl);
  if (!response.ok) {
    throw new Error("The bundled sample artwork could not be loaded.");
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mime: "image/png",
    width: SAMPLE_ARTWORK_WIDTH,
    height: SAMPLE_ARTWORK_HEIGHT,
    layerName: `${PRODUCT_NAME} sample artwork`,
    title: "Sample",
  };
}
