/**
 * Preview presenter — draws PreviewService frames onto the visible canvas.
 * Browser-only glue; every branch of math it relies on lives in
 * layer-data-compose.ts (pure, unit-tested).
 *
 * Payload handling:
 * - "bitmap": composed proof — drawImage, then close the bitmap.
 * - "plates": composite views use the delivered proof raster; plate views
 *   convert that plate's premultiplied ink to monochrome #111214 over paper
 *   (legacy monochromePlate parity).
 * - "layer-data" (reduced path, no OffscreenCanvas): halftone placements
 *   rasterize on the visible thread through a scratch canvas (paintDot /
 *   custom stamp drawImage — the same geometry the workers use), then the
 *   plates compose with the shared knockout math.
 *
 * Registration marks are the engine's FINAL pass and are drawn here on the
 * main thread — which is also what makes CUSTOM registration shapes work in
 * the preview without worker support. Geometry mirrors the legacy
 * drawRegistration exactly, scaled by renderScale so preview matches export
 * at document scale.
 */

import {
  paintDot,
  type DotPlacement,
  type LayerPlateData,
  type RenderPlateId,
  type ComposedPlate,
} from "../../render";
import type { DotShape, RegistrationMode } from "../../core/types";
import { PREVIEW_PAPER, type PreviewFrame } from "../../app/preview-service";
import type { RasterData } from "../../export/orchestrator";
import {
  composeLayerDataPlates,
  plateViewRaster,
  proofRasterFromComposed,
} from "./layer-data-compose";

export type PresenterLayerShape = {
  dotShape: DotShape;
  strokeWidth: number;
  /** Prepared custom-dot stamp (canvas) when dotShape === "custom". */
  stamp?: CanvasImageSource;
};

export type PresenterRegistration = {
  size: number;
  offset: number;
  weight: number;
  mode: RegistrationMode;
  /** Prepared custom registration stamp (canvas), already sized. */
  stamp?: CanvasImageSource | null;
};

export type PresenterContext = {
  /** Plates the job computed (composite order or the single plate). */
  plates: RenderPlateId[];
  /**
   * Paper for plate views and reduced-path composites. NULL means the
   * artboard background is TRANSPARENT: composite proofs keep real alpha
   * (proofCompositeTransparent); plate solo views still render as opaque
   * film on cream.
   */
  paper: readonly [number, number, number] | null;
  /** Per-jobLayerIndex opacity (visible layers, bottom-to-top). */
  layerOpacities: readonly number[];
  /** Per-jobLayerIndex dot shape info for reduced-path halftone drawing. */
  layerShapes: readonly PresenterLayerShape[];
  registration: PresenterRegistration | null;
};

function putRaster(context: CanvasRenderingContext2D, raster: RasterData): void {
  context.putImageData(
    new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height),
    0,
    0,
  );
}

/** Rasterize halftone placements on a scratch canvas; alpha becomes ink. */
function rasterizeHalftoneLayer(
  layer: LayerPlateData,
  width: number,
  height: number,
  shape: PresenterLayerShape | undefined,
  renderScale: number,
): Float32Array {
  const ink = new Float32Array(width * height);
  if (!layer.placements || layer.placements.count === 0) return ink;
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (!context) return ink;
  context.fillStyle = "#000000";
  const packed = new Float64Array(layer.placements.buffer);
  const dotShape = shape?.dotShape ?? "round";
  const strokeWidth = (shape?.strokeWidth ?? 1) * renderScale;
  for (let index = 0; index < layer.placements.count; index += 1) {
    const dot: DotPlacement = {
      x: packed[index * 3],
      y: packed[index * 3 + 1],
      size: packed[index * 3 + 2],
    };
    if (dot.size <= 0.12) continue;
    if (dotShape === "custom" && shape?.stamp) {
      context.drawImage(shape.stamp, dot.x - dot.size / 2, dot.y - dot.size / 2, dot.size, dot.size);
    } else {
      paintDot(
        context as unknown as OffscreenCanvasRenderingContext2D,
        dot.x,
        dot.y,
        dot.size,
        dotShape === "custom" ? "round" : dotShape,
        strokeWidth,
      );
    }
  }
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 0; index < ink.length; index += 1) {
    ink[index] = pixels[index * 4 + 3] / 255;
  }
  return ink;
}

/** Legacy drawRegistration geometry, scaled to the frame's renderScale. */
export function drawRegistrationOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  registration: PresenterRegistration,
  renderScale: number,
): void {
  const size = Math.max(1, registration.size * renderScale);
  const offset = registration.offset * renderScale;
  const weight = Math.max(0.5, registration.weight * renderScale);
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.7;
  context.strokeStyle = "#121416";
  context.lineWidth = weight;
  const points: Array<[number, number]> =
    registration.mode === "centered"
      ? [
          [width / 2, offset],
          [width / 2, height - offset],
        ]
      : [
          [offset, offset],
          [width - offset, offset],
          [offset, height - offset],
          [width - offset, height - offset],
        ];
  for (const [x, y] of points) {
    if (registration.stamp) {
      context.drawImage(registration.stamp, x - size / 2, y - size / 2, size, size);
      continue;
    }
    context.beginPath();
    context.arc(x, y, size * 0.58, 0, Math.PI * 2);
    context.moveTo(x - size, y);
    context.lineTo(x + size, y);
    context.moveTo(x, y - size);
    context.lineTo(x, y + size);
    context.stroke();
  }
  context.restore();
}

/** Draw one frame. Returns false when the payload form cannot be shown. */
export function presentPreviewFrame(
  canvas: HTMLCanvasElement,
  frame: PreviewFrame,
  presenter: PresenterContext,
): boolean {
  const { payload } = frame;
  const width = payload.width;
  const height = payload.height;
  if (width < 1 || height < 1) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.clearRect(0, 0, width, height);

  if (payload.form === "bitmap") {
    context.drawImage(payload.bitmap, 0, 0);
    payload.bitmap.close();
  } else if (payload.form === "plates") {
    if (frame.view === "composite") {
      if (payload.proof) {
        putRaster(context, {
          data: new Uint8ClampedArray(payload.proof.buffer),
          width,
          height,
        });
      } else {
        // No proof delivered (plate-only job): fold plates ourselves.
        const composed: Partial<Record<RenderPlateId, ComposedPlate>> = {};
        for (const plate of payload.plates) {
          composed[plate.plate] = {
            inkPremultiplied: new Float32Array(plate.inkPremultiplied.buffer),
            alpha: new Float32Array(plate.alpha.buffer),
          };
        }
        putRaster(context, proofRasterFromComposed(composed, width, height, presenter.paper));
      }
    } else {
      const entry = payload.plates.find((plate) => plate.plate === presenter.plates[0]);
      putRaster(
        context,
        plateViewRaster(
          entry ? new Float32Array(entry.inkPremultiplied.buffer) : null,
          width,
          height,
          presenter.paper ?? PREVIEW_PAPER.white,
        ),
      );
    }
  } else if (payload.form === "layer-data") {
    const rasterize = (layer: LayerPlateData, w: number, h: number) =>
      rasterizeHalftoneLayer(
        layer,
        w,
        h,
        presenter.layerShapes[layer.layerIndex],
        frame.renderScale,
      );
    const composed = composeLayerDataPlates(
      payload,
      presenter.plates,
      presenter.layerOpacities,
      rasterize,
    );
    if (frame.view === "composite") {
      putRaster(context, proofRasterFromComposed(composed, width, height, presenter.paper));
    } else {
      const plate = composed[presenter.plates[0]];
      putRaster(
        context,
        plateViewRaster(
          plate ? plate.inkPremultiplied : null,
          width,
          height,
          presenter.paper ?? PREVIEW_PAPER.white,
        ),
      );
    }
  } else {
    return false;
  }

  if (presenter.registration) {
    drawRegistrationOverlay(context, width, height, presenter.registration, frame.renderScale);
  }
  return true;
}
