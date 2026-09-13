/**
 * SHA-256 over raw bytes for content-addressed assets. Feature-detects
 * WebCrypto (browsers, workers, Node >= 20) and falls back to node:crypto so
 * unit tests and tooling behave identically. Never silently degrades.
 */
import type { Sha256 } from "../core/types";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True when the value is a lowercase hex SHA-256 digest. */
export function isSha256Hex(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

type NodeHasher = { update(data: Uint8Array): NodeHasher; digest(encoding: "hex"): string };
let nodeCreateHash: ((algorithm: string) => NodeHasher) | null | undefined;

async function loadNodeCreateHash(): Promise<((algorithm: string) => NodeHasher) | null> {
  if (nodeCreateHash === undefined) {
    try {
      // Computed specifier: never bundled by Vite, never resolved by DOM-lib tsc.
      const specifier = "node:crypto";
      const { createHash } = (await import(/* @vite-ignore */ specifier)) as {
        createHash: (algorithm: string) => NodeHasher;
      };
      nodeCreateHash = createHash;
    } catch {
      nodeCreateHash = null;
    }
  }
  return nodeCreateHash;
}

/** Digest bytes to a lowercase hex SHA-256 string. Throws when no crypto backend exists. */
export async function sha256Hex(bytes: Uint8Array): Promise<Sha256> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes as BufferSource);
    return toHex(new Uint8Array(digest));
  }
  const createHash = await loadNodeCreateHash();
  if (!createHash) throw new Error("SHA-256 is unavailable: no WebCrypto or Node crypto backend.");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Chunk granularity for cooperative hashing/yield checkpoints. */
const HASH_CHUNK_BYTES = 1024 * 1024;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Small incremental implementation: no payload clone and only 64-word scratch. */
class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly schedule = new Uint32Array(64);
  private readonly tail = new Uint8Array(64);
  private tailLength = 0;
  private totalBytes = 0;

  update(bytes: Uint8Array): void {
    this.totalBytes += bytes.byteLength;
    let offset = 0;
    if (this.tailLength > 0) {
      const take = Math.min(64 - this.tailLength, bytes.byteLength);
      this.tail.set(bytes.subarray(0, take), this.tailLength);
      this.tailLength += take;
      offset = take;
      if (this.tailLength === 64) {
        this.processBlock(this.tail, 0);
        this.tailLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.processBlock(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.tail.set(bytes.subarray(offset), 0);
      this.tailLength = bytes.byteLength - offset;
    }
  }

  digestHex(): string {
    const bitLength = this.totalBytes * 8;
    this.tail[this.tailLength] = 0x80;
    this.tailLength += 1;
    if (this.tailLength > 56) {
      this.tail.fill(0, this.tailLength);
      this.processBlock(this.tail, 0);
      this.tailLength = 0;
    }
    this.tail.fill(0, this.tailLength, 56);
    const view = new DataView(this.tail.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000));
    view.setUint32(60, bitLength >>> 0);
    this.processBlock(this.tail, 0);
    let hex = "";
    for (const word of this.state) hex += word.toString(16).padStart(8, "0");
    return hex;
  }

  private processBlock(bytes: Uint8Array, offset: number): void {
    const words = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] =
        ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

/**
 * SHA-256 with cooperative preemption for operation-scoped imports.
 *
 * `checkpoint` is invoked before hashing starts, between chunks, and before
 * the digest is returned; it throws the operation's typed deadline/abort
 * error to stop the hash. This path deliberately avoids WebCrypto's
 * monolithic digest operation: browsers offer no way to cancel it and may
 * clone the complete payload. A bounded incremental state is updated in
 * chunks with a macrotask yield between chunks so abort events can land.
 */
export async function sha256HexAbortable(bytes: Uint8Array, checkpoint: () => void): Promise<Sha256> {
  checkpoint();
  const hasher = new IncrementalSha256();
  for (let offset = 0; offset < bytes.length; offset += HASH_CHUNK_BYTES) {
    if (offset > 0) {
      // Yield to the macrotask queue so abort events can land, then re-check.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    checkpoint();
    hasher.update(bytes.subarray(offset, Math.min(offset + HASH_CHUNK_BYTES, bytes.length)));
  }
  checkpoint();
  return hasher.digestHex();
}
