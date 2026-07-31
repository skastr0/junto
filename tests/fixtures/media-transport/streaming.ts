/**
 * Deterministic media fixtures for the media-transport e2e suite.
 *
 * Fixtures are generated, not Base64-encoded product payloads.  Large sizes
 * prove streaming behaviour without requiring multi-hundred-megabyte blobs in
 * the test tree: callers either materialize a mid-size body (transfer proof)
 * or stream a large logical length while tracking peak chunk residency.
 */

import { createHash } from "node:crypto";

/** Mid-size bodies that still exercise multi-chunk disk paths in CI. */
export const MEDIA_FIXTURE_SIZES = {
  /** Minimal image-class body. */
  image: 4_096,
  /** Audio-class stream (~256 KiB). */
  audio: 256 * 1024,
  /** Video-class stream (~2 MiB). */
  video: 2 * 1024 * 1024,
  /**
   * Large transfer body.  Multi-chunk and multi-megabyte without multi-hundred
   * MB CI cost; streaming peak-buffer tests cover the larger logical sizes.
   */
  large: 8 * 1024 * 1024,
  /** Logical multi-hundred-megabyte identity used only in control records. */
  hundredMegLogical: 300 * 1024 * 1024,
  /** Logical gigabyte identity (Station / WorkRecord bound proof). */
  gigabyteLogical: 1024 * 1024 * 1024,
} as const;

export const DEFAULT_STREAM_CHUNK = 64 * 1024;

/** Seeded deterministic payload — same seed + size always yields same bytes. */
export const makeDeterministicPayload = (
  size: number,
  seed = 0x5eed_c0de,
): Buffer => {
  const buf = Buffer.allocUnsafe(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    // xorshift32 — fast, deterministic, not crypto.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buf[i] = state & 0xff;
  }
  return buf;
};

export const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export type StreamStats = {
  /** Number of chunks yielded. */
  chunks: number;
  /** Total bytes yielded. */
  totalBytes: number;
  /** Largest single chunk Buffer.byteLength observed. */
  peakChunkBytes: number;
  /** Max concurrent residency assumed by a consumer holding one chunk. */
  peakResidentBytes: number;
};

/**
 * Async chunk stream over a prebuilt Buffer.  Tracks peak chunk residency so
 * tests can assert the consumer never needed the full body in one allocation
 * beyond the source buffer itself.
 */
export async function* streamBuffer(
  payload: Buffer,
  chunkSize = DEFAULT_STREAM_CHUNK,
  stats?: StreamStats,
): AsyncGenerator<Buffer, void, unknown> {
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, payload.length);
    // subarray shares memory with payload; for peak proof we allocate a copy
    // only when stats are requested so residency is measurable.
    const chunk =
      stats === undefined
        ? payload.subarray(offset, end)
        : Buffer.from(payload.subarray(offset, end));
    if (stats !== undefined) {
      stats.chunks += 1;
      stats.totalBytes += chunk.byteLength;
      stats.peakChunkBytes = Math.max(stats.peakChunkBytes, chunk.byteLength);
      // Consumer holds at most one chunk at a time under this contract.
      stats.peakResidentBytes = Math.max(
        stats.peakResidentBytes,
        chunk.byteLength,
      );
    }
    yield chunk;
  }
}

/**
 * Stream a large logical length without materializing the full body.
 * Used to prove ingest/transfer paths accept multi-hundred-MB-equivalent
 * streams when the caller only keeps one chunk resident.
 */
export async function* streamLogicalLength(
  byteLength: number,
  seed = 0x5eed_c0de,
  chunkSize = DEFAULT_STREAM_CHUNK,
  stats?: StreamStats,
): AsyncGenerator<Buffer, void, unknown> {
  let state = seed >>> 0;
  let produced = 0;
  while (produced < byteLength) {
    const n = Math.min(chunkSize, byteLength - produced);
    const chunk = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      chunk[i] = state & 0xff;
    }
    produced += n;
    if (stats !== undefined) {
      stats.chunks += 1;
      stats.totalBytes += n;
      stats.peakChunkBytes = Math.max(stats.peakChunkBytes, n);
      stats.peakResidentBytes = Math.max(stats.peakResidentBytes, n);
    }
    yield chunk;
  }
}

export const emptyStreamStats = (): StreamStats => ({
  chunks: 0,
  totalBytes: 0,
  peakChunkBytes: 0,
  peakResidentBytes: 0,
});

/** Minimal valid 1×1 PNG (70 bytes) — not Base64 in product paths. */
export const MINIMAL_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export type MediaKind = "image" | "audio" | "video" | "large";

export type MediaFixture = {
  readonly kind: MediaKind;
  readonly mediaType: string;
  readonly displayName: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
};

export const buildMediaFixture = (
  kind: MediaKind,
  seed = 0x5eed_c0de,
): MediaFixture => {
  switch (kind) {
    case "image": {
      // Prefer a real PNG header so media-type classification is honest;
      // pad to image size for multi-chunk range tests.
      const size = MEDIA_FIXTURE_SIZES.image;
      const bytes = Buffer.alloc(size, 0);
      MINIMAL_PNG_BYTES.copy(bytes, 0);
      if (size > MINIMAL_PNG_BYTES.length) {
        makeDeterministicPayload(size - MINIMAL_PNG_BYTES.length, seed).copy(
          bytes,
          MINIMAL_PNG_BYTES.length,
        );
      }
      return {
        kind,
        mediaType: "image/png",
        displayName: "fixture.png",
        bytes,
        sha256: sha256Hex(bytes),
        byteLength: bytes.length,
      };
    }
    case "audio": {
      const bytes = makeDeterministicPayload(MEDIA_FIXTURE_SIZES.audio, seed + 1);
      return {
        kind,
        mediaType: "audio/mpeg",
        displayName: "fixture.mp3",
        bytes,
        sha256: sha256Hex(bytes),
        byteLength: bytes.length,
      };
    }
    case "video": {
      const bytes = makeDeterministicPayload(MEDIA_FIXTURE_SIZES.video, seed + 2);
      return {
        kind,
        mediaType: "video/mp4",
        displayName: "fixture.mp4",
        bytes,
        sha256: sha256Hex(bytes),
        byteLength: bytes.length,
      };
    }
    case "large": {
      const bytes = makeDeterministicPayload(MEDIA_FIXTURE_SIZES.large, seed + 3);
      return {
        kind,
        mediaType: "application/octet-stream",
        displayName: "large.bin",
        bytes,
        sha256: sha256Hex(bytes),
        byteLength: bytes.length,
      };
    }
  }
};
