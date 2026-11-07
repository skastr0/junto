/**
 * The Files node's group: what the window asks of the core's Files service
 * and router, and the bytes a viewer streams over `junto-file:`. The core
 * answers them (`src/core/ops/files.ts`); main decodes what the window sends
 * at its own edge (`src/shared/files.ts`) and reaches the group through the
 * client service below (`src/app/files/ipc.ts`).
 *
 * A refusal is an answer the window reads as data, never an error of the
 * call: every result is a `FilesResult`, `{ ok: false, error }` included.
 * The one failure a call can have is `RpcClientError`, the core leaving
 * before it answered.
 *
 * A subscriber is a webContents id main gives: the core serves that number
 * and pushes its changes back tagged with it.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import {
  FileEntry,
  FileImported,
  FilePath,
  FileRead,
  FilesCount,
  FilesNodeRef,
  FilesResult,
  FilesRoot,
  FilesSearchResult,
  FilesSources,
  FileStamp,
  FILES_QUERY_MAX,
} from "../../shared/files";
import { coreClient } from "./link";

const Subscriber = Schema.Int;

/** An open file a viewer pulls from, by the token the core minted, and its size. */
export const FilesBytesOpened = Schema.Struct({ token: Schema.String, size: Schema.Natural });
export type FilesBytesOpened = typeof FilesBytesOpened.Type;

const Opened = FilesResult(FilesRoot);
const Nothing = FilesResult(Schema.Null);
const Entry = FilesResult(FileEntry);
const MovedTo = FilesResult(FilePath);

export const FilesRpcs = RpcGroup.make(
  Rpc.make("FilesOpen", { payload: { subscriber: Subscriber, ref: FilesNodeRef }, success: Opened }),
  Rpc.make("FilesClose", { payload: { subscriber: Subscriber, ref: FilesNodeRef }, success: Nothing }),
  Rpc.make("FilesCount", { payload: { ref: FilesNodeRef }, success: FilesResult(FilesCount) }),
  Rpc.make("FilesList", { payload: { ref: FilesNodeRef, dir: FilePath }, success: FilesResult(Schema.Array(FileEntry)) }),
  Rpc.make("FilesSearch", {
    payload: {
      subscriber: Subscriber,
      ref: FilesNodeRef,
      query: Schema.String.pipe(Schema.check(Schema.isMaxLength(FILES_QUERY_MAX))),
      seq: Schema.Int,
    },
    success: FilesResult(FilesSearchResult),
  }),
  Rpc.make("FilesRead", { payload: { ref: FilesNodeRef, path: FilePath }, success: FilesResult(FileRead) }),
  /** `base: null` writes back a file deleted under a draft. */
  Rpc.make("FilesWrite", {
    payload: { ref: FilesNodeRef, path: FilePath, text: Schema.String, base: Schema.NullOr(FileStamp) },
    success: FilesResult(FileStamp),
  }),
  Rpc.make("FilesCreate", { payload: { ref: FilesNodeRef, path: FilePath, dir: Schema.Boolean }, success: Entry }),
  Rpc.make("FilesRename", { payload: { ref: FilesNodeRef, path: FilePath, name: Schema.String }, success: MovedTo }),
  Rpc.make("FilesMove", { payload: { ref: FilesNodeRef, path: FilePath, into: FilePath }, success: MovedTo }),
  Rpc.make("FilesTrash", { payload: { ref: FilesNodeRef, path: FilePath }, success: Nothing }),
  /** Copies only what this window's drop carried, each once; `denied` for any other source. */
  Rpc.make("FilesImport", {
    payload: { subscriber: Subscriber, ref: FilesNodeRef, into: FilePath, sources: FilesSources },
    success: FilesResult(Schema.Array(FileImported)),
  }),
  Rpc.make("FilesOpenInDefaultApp", { payload: { ref: FilesNodeRef, path: FilePath }, success: Nothing }),
  Rpc.make("FilesReveal", { payload: { ref: FilesNodeRef, path: FilePath }, success: Nothing }),
  /** An OS path the window's preload saw on a real dropped File; the core holds it for that window until an import spends it. */
  Rpc.make("FilesDropped", { payload: { subscriber: Subscriber, path: Schema.String } }),
  /** A window is gone: its sessions and its dropped paths end with it. */
  Rpc.make("FilesWindowGone", { payload: { subscriber: Subscriber } }),
  Rpc.make("FilesBytesOpen", { payload: { node: Schema.String, path: FilePath }, success: FilesResult(FilesBytesOpened) }),
  Rpc.make("FilesBytesRead", {
    payload: { token: Schema.String, offset: Schema.Natural, length: Schema.Int },
    success: FilesResult(Schema.Uint8Array),
  }),
  Rpc.make("FilesBytesClose", { payload: { token: Schema.String } }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the Files group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class FilesCore extends Context.Service<FilesCore, RpcClient.FromGroup<typeof FilesRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/FilesCore",
) {
  static readonly layer = Layer.effect(FilesCore, coreClient(FilesRpcs));
}
