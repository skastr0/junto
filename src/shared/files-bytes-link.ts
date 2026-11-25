/**
 * The `file-bytes` link channel, as closed wire shapes (0.12.1, plan
 * 12-files-over-ssh, X3): a file's bytes read from another machine's Files
 * node in chunks, and a file dropped from this machine staged on that one in
 * chunks, then imported.
 *
 * A chunk is at most `FILE_BYTES_CHUNK_MAX` bytes decoded, sent as strict
 * canonical base64 whose length is checked before it is decoded. A stream or
 * an upload is named by a random 128-bit id good only on the link session that
 * made it; an id never names a path. Like `files`, a request names a Files
 * node and a path relative to its root, and nothing else.
 */

import { Schema } from "effect";
import { FilePathWire, FilesImported } from "./files-link";
import { isFileName } from "./files";
import { CANONICAL_CANVAS_NAME_PATTERN } from "./wire/canvas-name";
import { NodeId } from "./wire/ids";

/** The most bytes one chunk carries, decoded (remote-security, X3 term 1). */
export const FILE_BYTES_CHUNK_MAX = 48 * 1024;
/** Its base64 length: 4 characters for every 3 bytes. */
export const FILE_BYTES_CHUNK_BASE64_MAX = Math.ceil(FILE_BYTES_CHUNK_MAX / 3) * 4;
/** The largest `file-bytes` frame the session reads; a bigger one closes the link before it is decoded. */
export const FILE_BYTES_FRAME_MAX = 72 * 1024;
/** The most byte requests out on one link at once, each way: a request is the credit. */
export const FILE_BYTES_IN_FLIGHT = 2;
/** The largest file one drop stages. */
export const FILE_BYTES_UPLOAD_MAX = 512 * 1024 * 1024;

const CanvasName = Schema.String.pipe(Schema.check(Schema.isPattern(CANONICAL_CANVAS_NAME_PATTERN)));
const Where = { canvas: CanvasName, node: NodeId } as const;
/** 128 random bits, as lower-case hex. */
const ByteId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/u)));
const Offset = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: FILE_BYTES_UPLOAD_MAX })));
const Size = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.check(Schema.isFinite()));
const Stamp = Schema.Struct({ mtimeMs: Schema.Number, size: Schema.Number });
const Name = Schema.String.pipe(Schema.check(Schema.makeFilter((raw: string) => isFileName(raw))));

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * One chunk's bytes: canonical base64, no whitespace, its length checked
 * before it is decoded, and the bytes re-encoded to the same text, so one
 * chunk has one spelling.
 */
export const decodeChunk = (text: string): Uint8Array | undefined => {
  if (text.length > FILE_BYTES_CHUNK_BASE64_MAX || text.length % 4 !== 0 || !CANONICAL_BASE64.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64");
  if (bytes.byteLength > FILE_BYTES_CHUNK_MAX || bytes.toString("base64") !== text) return undefined;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};
export const encodeChunk = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

const ChunkText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(FILE_BYTES_CHUNK_BASE64_MAX)),
  Schema.check(Schema.makeFilter((raw: string) => decodeChunk(raw) !== undefined)),
);

export const FileBytesReadOpen = Schema.Struct({ ...Where, path: FilePathWire });
export const FileBytesReadOpened = Schema.Struct({ stream: ByteId, size: Size, stamp: Stamp });
export const FileBytesReadChunk = Schema.Struct({
  stream: ByteId, offset: Offset,
  length: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: FILE_BYTES_CHUNK_MAX }))),
});
/** Shorter than asked only at the file's end; empty past it. */
export const FileBytesChunk = Schema.Struct({ data: ChunkText });
export const FileBytesReadClose = Schema.Struct({ stream: ByteId });

export const FileBytesImportOpen = Schema.Struct({
  ...Where, into: FilePathWire, name: Name,
  size: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: FILE_BYTES_UPLOAD_MAX }))),
});
export const FileBytesImportOpened = Schema.Struct({ upload: ByteId });
export const FileBytesImportChunk = Schema.Struct({ upload: ByteId, offset: Offset, data: ChunkText });
export const FileBytesImportEnd = Schema.Struct({ upload: ByteId, sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))) });
export const FileBytesImported = FilesImported;
export const FileBytesDone = Schema.Null;
