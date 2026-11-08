/**
 * The window's model over IPC: the canvas list, a canvas opened, a command,
 * the compiled actor refs. Each asks the core's model group
 * (src/contract/core/model.ts). The renderer's arguments are decoded here, at
 * main's edge, closed, so the core is only ever handed a canvas name or a
 * command; one that does not decode rejects, as the core's decode did.
 */
import type { IpcMain } from "electron";
import { Context, Effect, Schema } from "effect";
import { Command } from "@shared/model";
import { IPC_CHANNELS } from "@shared/ipc";
import { ModelCanvasQuery, ModelCore } from "../../contract/core/model";
import { AppRuntime } from "../runtime";

const decodeCanvasQuery = (raw: unknown) => Schema.decodeUnknownEffect(ModelCanvasQuery)(raw, { onExcessProperty: "error" });
const decodeCommand = (raw: unknown) => Schema.decodeUnknownEffect(Command)(raw, { onExcessProperty: "error" });

/** `authoring` admits the command through main's authoring gate, under its own label (junto/ipc.ts). */
export const registerModelIpc = (
  ipc: Pick<IpcMain, "handle">,
  core: Context.Context<ModelCore>,
  authoring: <A>(operation: () => Promise<A>) => Promise<A>,
): void => {
  const model = Context.get(core, ModelCore);

  ipc.handle(IPC_CHANNELS.modelCanvases, () => AppRuntime.runPromise(model.ModelCanvases()));
  ipc.handle(IPC_CHANNELS.modelOpen, (_event, raw: unknown) =>
    AppRuntime.runPromise(Effect.flatMap(decodeCanvasQuery(raw), (query) => model.ModelOpen(query))),
  );
  ipc.handle(IPC_CHANNELS.modelCommand, (_event, raw: unknown) =>
    authoring(() => AppRuntime.runPromise(Effect.flatMap(decodeCommand(raw), (command) => model.ModelCommand({ command })))),
  );
  ipc.handle(IPC_CHANNELS.modelActorRefs, (_event, raw: unknown) =>
    AppRuntime.runPromise(Effect.flatMap(decodeCanvasQuery(raw), (query) => model.ModelActorRefs(query))),
  );
};
