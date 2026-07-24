/**
 * Pure Station projection compiler — no filesystem, no SSH.
 *
 * Input: complete name → document bytes map + generation witnesses.
 * Output: validated manifest + length-prefixed frame bytes.
 *
 * Frame:
 *   "VELLUM-STATION-PROJECTION/1\n"
 *   + uint32-be(manifestUtf8.byteLength)
 *   + manifestUtf8
 *   + document bodies in manifest.documents order
 */

import { createHash } from "node:crypto";
import { Either, Schema } from "effect";
import {
  STATION_PROJECTION_FRAME_MAGIC,
  STATION_PROJECTION_SCHEMA,
  STATION_PROJECTION_SCOPE,
  StationProjectionManifestV1,
  type Sha256Hex,
  type StationProjectionManifestV1 as Manifest,
} from "@shared/station-projection";
import { isCanonicalCanvasName } from "@shared/canvas-name";

export class StationProjectionCompileError extends Error {
  readonly code: "invalid" | "corrupt";
  constructor(code: StationProjectionCompileError["code"], message: string) {
    super(message);
    this.name = "StationProjectionCompileError";
    this.code = code;
  }
}

export type CompileStationProjectionInput = {
  readonly generation: string;
  readonly createdAt: string;
  /** Opaque SHA-256 hex of the producing Command Center seat. */
  readonly commandCenterWitness: string;
  /** Opaque SHA-256 hex of the intended Remote seat. */
  readonly targetWitness: string;
  /** Canvas name → exact document bytes (complete set for this generation). */
  readonly documents: ReadonlyMap<string, Uint8Array>;
};

export type CompiledStationProjection = {
  readonly manifest: Manifest;
  readonly frame: Uint8Array;
  readonly frameSha256: Sha256Hex;
  readonly manifestSha256: Sha256Hex;
  /** Document bodies in manifest order (same refs as input after sort). */
  readonly documents: ReadonlyArray<{
    readonly name: string;
    readonly body: Uint8Array;
  }>;
};

export type ParsedStationProjection = {
  readonly manifest: Manifest;
  readonly documents: ReadonlyMap<string, Uint8Array>;
  readonly frameSha256: Sha256Hex;
  readonly manifestSha256: Sha256Hex;
};

const sha256Hex = (bytes: Uint8Array | string): Sha256Hex =>
  createHash("sha256").update(bytes).digest("hex") as Sha256Hex;

const SHA256_RE = /^[a-f0-9]{64}$/;
const GENERATION_RE = /^(0|[1-9][0-9]*)$/;

const encodeManifestJson = (manifest: Manifest): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);

const intentSha256Of = (
  records: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
): Sha256Hex => {
  const intent = createHash("sha256");
  for (const rec of records) {
    intent.update(String(rec.name.length));
    intent.update("\0");
    intent.update(rec.name);
    intent.update(rec.sha256);
  }
  return intent.digest("hex") as Sha256Hex;
};

/**
 * Compile a complete full-canvas-set generation into a verified frame.
 * Document order is sorted by name for deterministic frames.
 */
export const compileStationProjection = (
  input: CompileStationProjectionInput,
): CompiledStationProjection => {
  if (!GENERATION_RE.test(input.generation) || input.generation.length > 32) {
    throw new StationProjectionCompileError(
      "invalid",
      `invalid projection generation: ${input.generation}`,
    );
  }
  if (!SHA256_RE.test(input.commandCenterWitness)) {
    throw new StationProjectionCompileError(
      "invalid",
      "commandCenterWitness must be lowercase sha256 hex",
    );
  }
  if (!SHA256_RE.test(input.targetWitness)) {
    throw new StationProjectionCompileError(
      "invalid",
      "targetWitness must be lowercase sha256 hex",
    );
  }
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) {
    throw new StationProjectionCompileError("invalid", "createdAt is required");
  }
  if (input.documents.size > 256) {
    throw new StationProjectionCompileError(
      "invalid",
      "projection exceeds 256 documents",
    );
  }

  const entries = [...input.documents.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const documentRecords: Array<{
    readonly name: string;
    readonly bytes: number;
    readonly sha256: Sha256Hex;
    readonly body: Uint8Array;
  }> = [];

  for (const [name, body] of entries) {
    if (!isCanonicalCanvasName(name)) {
      throw new StationProjectionCompileError(
        "invalid",
        `non-canonical canvas name: ${name}`,
      );
    }
    const hash = sha256Hex(body);
    documentRecords.push({
      name,
      bytes: body.byteLength,
      sha256: hash,
      body,
    });
  }

  const intentSha256 = intentSha256Of(documentRecords);
  const manifest: Manifest = {
    schema: STATION_PROJECTION_SCHEMA,
    scope: STATION_PROJECTION_SCOPE,
    generation: input.generation,
    createdAt: input.createdAt,
    commandCenterWitness: input.commandCenterWitness as Sha256Hex,
    targetWitness: input.targetWitness as Sha256Hex,
    intentSha256,
    documents: documentRecords.map(({ name, bytes, sha256 }) => ({
      name,
      bytes,
      sha256,
    })),
  };

  // Fail closed on schema drift before we ship bytes.
  const decoded = Schema.decodeUnknownEither(StationProjectionManifestV1)(
    manifest,
  );
  if (Either.isLeft(decoded)) {
    throw new StationProjectionCompileError(
      "invalid",
      "compiled manifest failed schema decode",
    );
  }

  const manifestBytes = encodeManifestJson(manifest);
  if (manifestBytes.byteLength > 0xffff_ffff) {
    throw new StationProjectionCompileError("invalid", "manifest too large");
  }

  const magic = new TextEncoder().encode(STATION_PROJECTION_FRAME_MAGIC);
  const lengthPrefix = new Uint8Array(4);
  new DataView(lengthPrefix.buffer).setUint32(
    0,
    manifestBytes.byteLength,
    false,
  );

  let total = magic.byteLength + 4 + manifestBytes.byteLength;
  for (const rec of documentRecords) total += rec.body.byteLength;

  const frame = new Uint8Array(total);
  let offset = 0;
  frame.set(magic, offset);
  offset += magic.byteLength;
  frame.set(lengthPrefix, offset);
  offset += 4;
  frame.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;
  for (const rec of documentRecords) {
    frame.set(rec.body, offset);
    offset += rec.body.byteLength;
  }

  return {
    manifest: decoded.right,
    frame,
    frameSha256: sha256Hex(frame),
    manifestSha256: sha256Hex(manifestBytes),
    documents: documentRecords.map(({ name, body }) => ({ name, body })),
  };
};

/**
 * Parse + verify a station projection frame. Fails closed on any mismatch.
 */
export const parseStationProjectionFrame = (
  frame: Uint8Array,
): ParsedStationProjection => {
  const magic = new TextEncoder().encode(STATION_PROJECTION_FRAME_MAGIC);
  if (frame.byteLength < magic.byteLength + 4) {
    throw new StationProjectionCompileError("corrupt", "frame too short");
  }
  for (let i = 0; i < magic.byteLength; i++) {
    if (frame[i] !== magic[i]) {
      throw new StationProjectionCompileError(
        "corrupt",
        "frame magic mismatch",
      );
    }
  }

  const view = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  );
  const manifestLen = view.getUint32(magic.byteLength, false);
  const manifestStart = magic.byteLength + 4;
  const manifestEnd = manifestStart + manifestLen;
  if (manifestLen === 0 || manifestEnd > frame.byteLength) {
    throw new StationProjectionCompileError(
      "corrupt",
      "manifest length out of bounds",
    );
  }

  const manifestBytes = frame.subarray(manifestStart, manifestEnd);
  let manifestParsed: unknown;
  try {
    manifestParsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new StationProjectionCompileError(
      "corrupt",
      "manifest is not valid JSON",
    );
  }

  const manifestResult =
    Schema.decodeUnknownEither(StationProjectionManifestV1)(manifestParsed);
  if (Either.isLeft(manifestResult)) {
    throw new StationProjectionCompileError(
      "corrupt",
      "manifest failed schema",
    );
  }
  const manifest = manifestResult.right;

  const documents = new Map<string, Uint8Array>();
  let cursor = manifestEnd;
  for (const entry of manifest.documents) {
    if (!isCanonicalCanvasName(entry.name)) {
      throw new StationProjectionCompileError(
        "corrupt",
        `non-canonical canvas name in manifest: ${entry.name}`,
      );
    }
    if (documents.has(entry.name)) {
      throw new StationProjectionCompileError(
        "corrupt",
        `duplicate document name: ${entry.name}`,
      );
    }
    const next = cursor + entry.bytes;
    if (next > frame.byteLength) {
      throw new StationProjectionCompileError(
        "corrupt",
        `document body truncated: ${entry.name}`,
      );
    }
    const body = frame.subarray(cursor, next);
    const hash = sha256Hex(body);
    if (hash !== entry.sha256) {
      throw new StationProjectionCompileError(
        "corrupt",
        `document hash mismatch: ${entry.name}`,
      );
    }
    if (body.byteLength !== entry.bytes) {
      throw new StationProjectionCompileError(
        "corrupt",
        `document byte length mismatch: ${entry.name}`,
      );
    }
    documents.set(entry.name, body);
    cursor = next;
  }

  if (cursor !== frame.byteLength) {
    throw new StationProjectionCompileError(
      "corrupt",
      "frame has trailing bytes after documents",
    );
  }

  const expectedIntent = intentSha256Of(manifest.documents);
  if (expectedIntent !== manifest.intentSha256) {
    throw new StationProjectionCompileError(
      "corrupt",
      "intentSha256 does not match document set",
    );
  }

  // Names must be sorted (deterministic compile contract).
  for (let i = 1; i < manifest.documents.length; i++) {
    const prev = manifest.documents[i - 1]!.name;
    const curr = manifest.documents[i]!.name;
    if (prev >= curr) {
      throw new StationProjectionCompileError(
        "corrupt",
        "manifest documents are not strictly sorted by name",
      );
    }
  }

  return {
    manifest,
    documents,
    frameSha256: sha256Hex(frame),
    manifestSha256: sha256Hex(manifestBytes),
  };
};
