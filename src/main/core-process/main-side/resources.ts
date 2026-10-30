/**
 * Main's side of the renderer's tasks, artifacts and their threads: the same
 * channels as before, each answer one core call under the same authoring
 * label. A product this build turns off registers nothing.
 */
import type { IpcMain } from "electron";
import { productResourceKindEnabled } from "@shared/features";
import { RESOURCE_IPC_CHANNELS } from "@shared/resource-ipc";
import type { ResourceAuthoring } from "../../junto/work/resource-ipc";
import type { CoreClient } from "../client";

export const registerResourceIpcCore = (
  ipc: Pick<IpcMain, "handle">,
  core: CoreClient,
  enabled: { readonly task: boolean; readonly artifact: boolean; readonly file: boolean },
  authoring: { readonly task: ResourceAuthoring; readonly artifact: ResourceAuthoring; readonly thread: ResourceAuthoring },
): (() => void) => {
  const live = {
    task: enabled.task && productResourceKindEnabled("task"),
    artifact: enabled.artifact && productResourceKindEnabled("artifact"),
    file: enabled.file,
  };
  const on = <O>(
    channel: string,
    call: (input: unknown) => Promise<O>,
    authored?: ResourceAuthoring,
  ): void => {
    ipc.handle(channel, (_event, input: unknown) => {
      const operation = () => call(input);
      return authored === undefined ? operation() : (authored(operation) as Promise<O>);
    });
  };
  const task = RESOURCE_IPC_CHANNELS.task;
  if (live.task) {
    on(task.list, (input) => core.call("ipc.resource.task.list", { input }));
    on(task.all, (input) => core.call("ipc.resource.task.all", { input }));
    on(task.context, (input) => core.call("ipc.resource.task.context", { input }));
    on(task.apply, (input) => core.call("ipc.resource.task.apply", { input }), authoring.task);
    on(task.pending, (input) => core.call("ipc.resource.task.pending", { input }));
  }
  const artifact = RESOURCE_IPC_CHANNELS.artifact;
  if (live.artifact) {
    on(artifact.list, (input) => core.call("ipc.resource.artifact.list", { input }));
    on(artifact.history, (input) => core.call("ipc.resource.artifact.history", { input }));
    on(artifact.moves, (input) => core.call("ipc.resource.artifact.moves", { input }));
    on(artifact.body, (input) => core.call("ipc.resource.artifact.body", { input }));
    on(artifact.apply, (input) => core.call("ipc.resource.artifact.apply", { input }), authoring.artifact);
    on(artifact.pending, (input) => core.call("ipc.resource.artifact.pending", { input }));
    on(artifact.labelColours, (input) => core.call("ipc.resource.artifact.labelColours", { input }));
    on(artifact.colour, (input) => core.call("ipc.resource.artifact.colour", { input }), authoring.artifact);
  }
  const thread = RESOURCE_IPC_CHANNELS.thread;
  if (live.task || live.artifact || live.file) {
    on(thread.list, (input) => core.call("ipc.resource.thread.list", { input }));
    on(thread.post, (input) => core.call("ipc.resource.thread.post", { input }), authoring.thread);
  }
  return () => undefined;
};
