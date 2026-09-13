/**
 * Worker-side layer prep (src/render/prep.ts) must be bit-identical to the
 * main-thread reference (export/layer-prep.ts prepareLayerRaster) for the
 * same crop + homography, for every band height — that identity is what
 * lets the service ship prep descriptors instead of pre-warped rasters.
 */
import { describe, expect, it } from "vitest";
import { buildLayerPrep, prepareLayerRaster } from "../../src/export/layer-prep";
import { resolvePrepRaster, warpRasterBanded } from "../../src/render/prep";
import { warpRaster } from "../../src/editor/homography";
import { mat3FromValues } from "../../src/editor/matrix";
import type { LayerPrepTransfer } from "../../src/render/protocol";
import { gradientRaster, transparentRegionsRaster } from "../../src/render/fixtures";
import type { LayerV1 } from "../../src/core/types";

const OUT_W = 40;
const OUT_H = 28;

function transformOf(overrides: Partial<LayerV1["transform"]> = {}): LayerV1["transform"] {
  return {
    position: { x: OUT_W / 2, y: OUT_H / 2 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    flipH: false,
    flipV: false,
    skew: { x: 0, y: 0 },
    perspective: null,
    ...overrides,
  };
}

function layerOf(
  transform: LayerV1["transform"],
  crop: LayerV1["crop"] = null,
): Pick<LayerV1, "crop" | "transform"> {
  return { crop, transform };
}

async function viaWorkerPrep(
  layer: Pick<LayerV1, "crop" | "transform">,
  source: ReturnType<typeof gradientRaster>,
) {
  const built = buildLayerPrep(layer, source, {
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    renderScale: 1,
  });
  const prep: LayerPrepTransfer = {
    // Simulate the structured-clone boundary: fresh buffer, plain array.
    source: {
      buffer: (built.source.buffer as ArrayBuffer).slice(0),
      width: built.source.width,
      height: built.source.height,
    },
    crop: built.crop,
    homography: [...built.homography],
  };
  return resolvePrepRaster(prep, OUT_W, OUT_H, undefined);
}

describe("worker-side prep vs prepareLayerRaster", () => {
  const cases: Array<[string, Pick<LayerV1, "crop" | "transform">, ReturnType<typeof gradientRaster>]> = [
    ["identity full-frame", layerOf(transformOf()), gradientRaster(OUT_W, OUT_H)],
    [
      "rotation + scale + skew + flip",
      layerOf(
        transformOf({
          rotation: 23,
          scale: { x: 1.4, y: 0.8 },
          skew: { x: 8, y: -4 },
          flipH: true,
          position: { x: 17, y: 11 },
        }),
      ),
      transparentRegionsRaster(21, 17),
    ],
    [
      "crop window",
      layerOf(transformOf({ position: { x: 20, y: 14 } }), { x: 3, y: 2, width: 9, height: 7 }),
      gradientRaster(21, 17),
    ],
    [
      "perspective quad",
      layerOf(
        transformOf({
          perspective: [
            { x: 4, y: 3 },
            { x: 34, y: 6 },
            { x: 36, y: 25 },
            { x: 2, y: 22 },
          ],
        }),
      ),
      gradientRaster(21, 17),
    ],
    [
      "invalid crop falls back to full asset",
      layerOf(transformOf(), { x: 10, y: 10, width: 900, height: 900 }),
      gradientRaster(21, 17),
    ],
  ];

  for (const [name, layer, source] of cases) {
    it(`bit-identical: ${name}`, async () => {
      const reference = prepareLayerRaster(layer, source, {
        outputWidth: OUT_W,
        outputHeight: OUT_H,
        renderScale: 1,
      });
      const viaPrep = await viaWorkerPrep(layer, source);
      expect(viaPrep.width).toBe(reference.width);
      expect(viaPrep.height).toBe(reference.height);
      expect(Buffer.from(viaPrep.data).equals(Buffer.from(reference.data))).toBe(true);
    });
  }

  it("banded warp is bit-identical to a whole-image warp for every band height", async () => {
    const source = transparentRegionsRaster(30, 22);
    const homography = mat3FromValues(1.3, 0.2, -2, -0.1, 0.9, 3, 0.001, 0, 1);
    const whole = warpRaster(source, homography, { x: 0, y: 0, width: OUT_W, height: OUT_H });
    for (const bandRows of [1, 3, 7, OUT_H, OUT_H * 2]) {
      const banded = await warpRasterBanded(source, homography, OUT_W, OUT_H, undefined, bandRows);
      expect(Buffer.from(banded.data).equals(Buffer.from(whole.data))).toBe(true);
    }
  });

  it("checkpoints are awaited between warp bands and abort mid-warp", async () => {
    const source = gradientRaster(24, 24);
    const homography = mat3FromValues(1, 0, 0, 0, 1, 0, 0, 0, 1);
    let calls = 0;
    await warpRasterBanded(source, homography, 24, 24, () => void (calls += 1), 4);
    expect(calls).toBe(5); // 6 bands, checkpoint between each pair
    const abort = new Error("stop-warp");
    calls = 0;
    await expect(
      warpRasterBanded(
        source,
        homography,
        24,
        24,
        () => {
          calls += 1;
          if (calls === 2) throw abort;
        },
        4,
      ),
    ).rejects.toBe(abort);
  });
});
