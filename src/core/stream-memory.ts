/** Shared hard bounds for streamed export staging. */

export const PNG_IDAT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_DEFLATE_READ_CHUNK_BYTES = 1024 * 1024;
export const MAX_ZIP_STREAM_CHUNK_BYTES = 1024 * 1024;
export const SVG_TEXT_CHUNK_CHARS = 256 * 1024;

/**
 * Conservative fixed envelope outside row-shaped buffers: compressor
 * windows/queues, the 64 KiB coalescer and IDAT frame, ZIP staging, one
 * bounded sink chunk/native write copy, headers, and implementation margin.
 * Observable chunks are hard-capped above; browser UASM covers native terms.
 */
export const STREAM_ENCODE_FIXED_BYTES = 8 * 1024 * 1024;
