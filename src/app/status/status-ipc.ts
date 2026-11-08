/**
 * The window's status reads over IPC: the authority banner, a canvas digest,
 * usage and the kernel snapshot. Each asks the core's status group
 * (src/contract/core/status.ts), where the authorities, the model, usage and
 * the kernel plane run.
 */
import type { IpcMain } from "electron";
import { Context, Effect, Schema } from "effect";
import { USAGE_ENABLED } from "@shared/features";
import { IPC_CHANNELS } from "@shared/ipc";
import { StatusCore } from "../../contract/core/status";
import { AppRuntime } from "../runtime";

export const registerStatusIpc = (ipc: Pick<IpcMain, "handle">, core: Context.Context<StatusCore>): void => {
  const status = Context.get(core, StatusCore);

  // The authority read (0.11/06 F5): null with the authority off, so a ship window shows none of it.
  ipc.handle(IPC_CHANNELS.authorityRead, () => AppRuntime.runPromise(status.StatusAuthority()));

  ipc.handle(IPC_CHANNELS.canvasDigest, (_event, raw: unknown) =>
    AppRuntime.runPromise(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)(raw, { onExcessProperty: "error" }), (name) =>
        status.StatusDigest({ name }),
      ),
    ),
  );

  if (USAGE_ENABLED) {
    ipc.handle(IPC_CHANNELS.getUsage, () => AppRuntime.runPromise(status.StatusUsageCurrent()));
    ipc.handle(IPC_CHANNELS.refreshUsage, () => AppRuntime.runPromise(status.StatusUsageRefresh()));
  }

  // The kernel plane: seat and task evaluation over every hydrated canvas,
  // running continuously in the core regardless of window state.
  ipc.handle(IPC_CHANNELS.getKernelState, () => AppRuntime.runPromise(status.StatusKernel()));
};
