/**
 * Central resource policy. Every limit that guards memory, storage, or
 * archive handling lives here so preflight, import, render planning, and
 * export all agree. Values are initial-release settings; adjust in one place.
 */
export type ResourcePolicy = {
  /** Max source raster file size in bytes. */
  maxRasterBytes: number;
  /** Max source raster pixels (width * height). */
  maxRasterPixels: number;
  /** Max artboard pixels (width * height) at DOCUMENT_DPI. */
  maxArtboardPixels: number;
  /** Max either artboard edge; bounds row/column scratch and canvas limits. */
  maxArtboardEdge: number;
  maxLayers: number;
  maxSnapshots: number;
  maxUndoTransactions: number;
  /** Max entries inside any accepted ZIP archive. */
  maxArchiveEntries: number;
  /** Max compressed archive size in bytes. */
  maxArchiveCompressedBytes: number;
  /** Max actual uncompressed bytes across all entries. */
  maxArchiveUncompressedBytes: number;
  /** Largest export that may fall back to a Blob download. */
  maxBlobDownloadBytes: number;
  /** Estimated render peak memory budget in bytes. */
  maxRenderPeakBytes: number;
};

export const RESOURCE_POLICY: ResourcePolicy = {
  maxRasterBytes: 50 * 1024 * 1024,
  maxRasterPixels: 100_000_000,
  maxArtboardPixels: 20_000_000,
  maxArtboardEdge: 32_768,
  maxLayers: 32,
  maxSnapshots: 50,
  maxUndoTransactions: 100,
  maxArchiveEntries: 512,
  maxArchiveCompressedBytes: 512 * 1024 * 1024,
  maxArchiveUncompressedBytes: 1.5 * 1024 * 1024 * 1024,
  maxBlobDownloadBytes: 256 * 1024 * 1024,
  maxRenderPeakBytes: 768 * 1024 * 1024,
};
