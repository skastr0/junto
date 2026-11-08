/**
 * The shell the core's Files service asks main for: Trash, Open and Reveal
 * are Electron's (`src/app/core-process/main-side/files.ts`), the service
 * that wants them is the core's (`src/core/ops/files.ts`).
 *
 * `OpenPath` answers "" on success, else the reason, as `shell.openPath` does.
 * A Trash or Reveal the shell refuses fails with `FilesShellRefused`.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { hostClient } from "./link";

/** The shell refused the path; the message is its own. */
export class FilesShellRefused extends Schema.TaggedError<FilesShellRefused>()("FilesShellRefused", {
  message: Schema.String,
}) {}

const Absolute = { absolute: Schema.String };

export const FilesHostRpcs = RpcGroup.make(
  Rpc.make("FilesShellTrash", { payload: Absolute, success: Schema.Void, error: FilesShellRefused }),
  Rpc.make("FilesShellOpenPath", { payload: Absolute, success: Schema.String }),
  Rpc.make("FilesShellReveal", { payload: Absolute, success: Schema.Void, error: FilesShellRefused }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The core's client of the files shell group. */
export class FilesHost extends Context.Service<
  FilesHost,
  RpcClient.FromGroup<typeof FilesHostRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/FilesHost") {
  static readonly layer = Layer.effect(FilesHost, hostClient(FilesHostRpcs));
}
