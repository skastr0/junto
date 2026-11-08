/**
 * How a file's bytes leave the core (0.12 X2): whoever holds the file reads it
 * in pieces, and whoever serves it pulls those pieces. Two shapes, no
 * Electron: the core reads a handle, main's protocol asks for chunks by
 * offset, so a large PDF or video never crosses a process in one message.
 */
import type { FileHandle } from "node:fs/promises";
import { FILE_BYTE_CHUNK } from "@shared/files";

export type FileBytesReader = {
  readonly size: number;
  readonly read: (offset: number, length: number) => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
};

/** A file opened here, read in pieces: the one shape a viewer streams from. */
export const readerOfHandle = (handle: FileHandle, size: number): FileBytesReader => ({
  size,
  read: async (offset, length) => {
    const buffer = Buffer.alloc(Math.max(1, Math.min(Math.trunc(length), FILE_BYTE_CHUNK)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  },
  close: async () => {
    await handle.close();
  },
});
