/**
 * The window's work pages over IPC: one task, the attention snapshot, a page
 * of a node's mail, and a seat's recent operations. Each asks the core's work
 * group (src/contract/core/work.ts), where the store is. The renderer's query
 * is decoded here, at main's edge, closed; one that does not decode rejects,
 * as the core's decode did.
 */
import type { IpcMain } from "electron";
import { Context, Effect, Schema } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { WorkMailQuery } from "@shared/work-mail";
import { WorkAttentionQuery, WorkItemQuery } from "@shared/work-sinks";
import { WorkCore, WorkSeatRecentOpsQuery } from "../../contract/core/work";
import { AppRuntime } from "../runtime";

/** A renderer argument, decoded closed. */
const decoded = <S extends Schema.Top>(schema: S, raw: unknown) =>
  Schema.decodeUnknownEffect(schema)(raw, { onExcessProperty: "error" });

export const registerWorkIpc = (ipc: Pick<IpcMain, "handle">, core: Context.Context<WorkCore>): void => {
  const work = Context.get(core, WorkCore);

  ipc.handle(IPC_CHANNELS.workItem, (_event, raw: unknown) =>
    AppRuntime.runPromise(Effect.flatMap(decoded(WorkItemQuery, raw), (query) => work.WorkItem(query))),
  );
  ipc.handle(IPC_CHANNELS.workAttention, (_event, raw: unknown) =>
    AppRuntime.runPromise(Effect.flatMap(decoded(WorkAttentionQuery, raw), (query) => work.WorkAttention(query))),
  );
  ipc.handle(IPC_CHANNELS.workMailPage, (_event, raw: unknown) =>
    AppRuntime.runPromise(Effect.flatMap(decoded(WorkMailQuery, raw), (query) => work.WorkMailPage(query))),
  );
  ipc.handle(IPC_CHANNELS.workSeatRecentOps, (_event, canvas: unknown, nodeId: unknown, limit: unknown) =>
    AppRuntime.runPromise(
      Effect.flatMap(
        decoded(WorkSeatRecentOpsQuery, { canvas, nodeId, ...(limit === undefined ? {} : { limit }) }),
        (query) => work.WorkSeatRecentOps(query),
      ),
    ),
  );
};
