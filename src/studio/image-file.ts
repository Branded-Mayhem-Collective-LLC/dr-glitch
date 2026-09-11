export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 100_000_000;

const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

/** File.type is caller-controlled; inspect the format before browser decoding. */
export async function validateImageSignature(file: File): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const matches = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
    const valid = file.type.toLowerCase() === "image/png"
      ? matches([137, 80, 78, 71, 13, 10, 26, 10])
      : file.type.toLowerCase() === "image/jpeg"
        ? matches([255, 216, 255])
        : file.type.toLowerCase() === "image/webp" && matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8);
    return valid ? null : "That file does not contain the selected PNG, JPG, or WebP format.";
  } catch { return "That image could not be read."; }
}

export function validateImageFile(file: Pick<File, "type" | "size">): string | null {
  if (!supportedTypes.has(file.type.toLowerCase())) return "Choose a PNG, JPG, or WebP image.";
  if (file.size === 0) return "That image is empty.";
  if (file.size > MAX_IMAGE_BYTES) return "Choose an image smaller than 50 MB.";
  return null;
}

export function validateImageDimensions(width: number, height: number): string | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return "That image has invalid dimensions.";
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    return "Choose an image no larger than 16,384 px per side and 100 megapixels.";
  }
  return null;
}
