import type { RegistrationV1 } from "../core/types";
import { REGISTRATION_PAINT_ROWS } from "../core/registration-memory";
import type { RegistrationRowPainter } from "../export/orchestrator";
import { registrationPoints } from "../export/output-transforms";
import { retainAllocation, yieldToEventLoop } from "../render/instrumentation";
import type { CustomShapeAsset } from "../studio/custom-shape-data";

/** Same canonical stamp, source-over opacity and document coordinates as canvas export. */
export async function prepareRegistrationRows(
  shape: CustomShapeAsset,
  registration: RegistrationV1,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<RegistrationRowPainter> {
  signal?.throwIfAborted();
  const { prepareCustomShape, customShapeStamp } = await import("../studio/custom-shape");
  signal?.throwIfAborted();
  await prepareCustomShape(shape);
  signal?.throwIfAborted();
  const { points, size } = registrationPoints(registration, width, height);
  // This stamp belongs to this export; it must not enter the slider cache.
  const stamp = customShapeStamp(shape, "#121416", size * 2, { cache: false });
  const releaseStamp = retainAllocation(stamp.width * stamp.height * 4, "canvas", "registration-stamp");
  let disposed = false;
  return {
    async paintRows(rows, rowStart, rowCount, paintSignal = signal) {
      if (disposed) throw new Error("Registration painter has been disposed.");
      if (rowStart < 0 || rowCount < 0 || rowStart + rowCount > height || rows.length !== width * rowCount * 4) {
        throw new Error("Invalid registration band geometry.");
      }
      for (let localRow = 0; localRow < rowCount; localRow += REGISTRATION_PAINT_ROWS) {
        paintSignal?.throwIfAborted();
        if (disposed) throw new Error("Registration painter has been disposed.");
        const count = Math.min(REGISTRATION_PAINT_ROWS, rowCount - localRow);
        const canvas = document.createElement("canvas");
        const release = retainAllocation(width * count * 8, "canvas", "registration-band-and-readback");
        try {
          canvas.width = width;
          canvas.height = count;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Canvas is unavailable for registration marks.");
          const pixels = rows.subarray(localRow * width * 4, (localRow + count) * width * 4);
          context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, count), 0, 0);
          context.globalAlpha = 0.7;
          for (const [x, y] of points) {
            context.drawImage(stamp, x - size / 2, y - size / 2 - rowStart - localRow, size, size);
          }
          pixels.set(context.getImageData(0, 0, width, count).data);
        } finally {
          canvas.width = canvas.height = 0;
          release();
        }
        if (localRow + count < rowCount) await yieldToEventLoop();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stamp.width = stamp.height = 0;
      releaseStamp();
    },
  };
}
