/** A cancellable image load that owns and always revokes its object URL. */
export function loadImageBlob(
  blob: Blob,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HTMLImageElement> {
  const { signal, timeoutMs = 10_000 } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const image = new Image();
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      image.onload = image.onerror = null;
      URL.revokeObjectURL(url);
      if (error !== undefined) { image.src = ""; reject(error); }
      else resolve(image);
    };
    const abort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new Error("The image took too long to open.")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    image.onload = () => finish();
    image.onerror = () => finish(new Error("The image could not be opened."));
    try { image.src = url; } catch (error) { finish(error); }
  });
}
