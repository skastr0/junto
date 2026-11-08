/**
 * Main's side of the renderer's tasks, artifacts and their threads: the same
 * channels as before, each answer one call of the core's resources group
 * (src/contract/core/resources.ts) under the same authoring label. What the
 * renderer sends is decoded here, closed, so the core is only ever handed a
 * payload that decoded; one that does not rejects the renderer's call. A
 * product this build turns off registers nothing.
 */
import type { IpcMain } from "electron";
import { Context, Result, type Schema } from "effect";
import { productResourceKindEnabled } from "@shared/features";
import {
  decodeArtifactApplyInput,
  decodeArtifactBodyInput,
  decodeArtifactColourInput,
  decodeArtifactHistoryInput,
  decodeArtifactLabelColoursInput,
  decodeArtifactListInput,
  decodeArtifactMovesInput,
  decodeArtifactPendingInput,
  decodeTaskAllInput,
  decodeTaskApplyInput,
  decodeTaskContextInput,
  decodeTaskListInput,
  decodeTaskPendingInput,
  decodeThreadListInput,
  decodeThreadPostInput,
  RESOURCE_IPC_CHANNELS,
} from "@shared/resource-ipc";
import type { ResourceAuthoring } from "../../../core/work/resource-ipc";
import { ResourcesCore } from "../../../contract/core/resources";
import { AppRuntime } from "../../runtime";

/** A call that decodes what the renderer sent before it asks the core; a payload that does not decode rejects. */
const decoding =
  <I, A>(decode: (raw: unknown) => Result.Result<I, Schema.SchemaError>, ask: (input: I) => Promise<A>) =>
  (raw: unknown): Promise<A> => {
    const decoded = decode(raw);
    return Result.isFailure(decoded) ? Promise.reject(new Error(decoded.failure.message)) : ask(decoded.success);
  };

export const registerResourceIpcCore = (
  ipc: Pick<IpcMain, "handle">,
  core: Context.Context<ResourcesCore>,
  enabled: { readonly task: boolean; readonly artifact: boolean; readonly file: boolean },
  authoring: { readonly task: ResourceAuthoring; readonly artifact: ResourceAuthoring; readonly thread: ResourceAuthoring },
): (() => void) => {
  const resources = Context.get(core, ResourcesCore);
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
    on(task.list, decoding(decodeTaskListInput, (input) => AppRuntime.runPromise(resources.ResourceTaskList(input))));
    on(task.all, decoding(decodeTaskAllInput, (input) => AppRuntime.runPromise(resources.ResourceTaskAll(input))));
    on(task.context, decoding(decodeTaskContextInput, (input) => AppRuntime.runPromise(resources.ResourceTaskContext(input))));
    on(
      task.apply,
      decoding(decodeTaskApplyInput, (input) => AppRuntime.runPromise(resources.ResourceTaskApply(input))),
      authoring.task,
    );
    on(task.pending, decoding(decodeTaskPendingInput, (input) => AppRuntime.runPromise(resources.ResourceTaskPending(input))));
  }
  const artifact = RESOURCE_IPC_CHANNELS.artifact;
  if (live.artifact) {
    on(artifact.list, decoding(decodeArtifactListInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactList(input))));
    on(
      artifact.history,
      decoding(decodeArtifactHistoryInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactHistory(input))),
    );
    on(artifact.moves, decoding(decodeArtifactMovesInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactMoves(input))));
    on(artifact.body, decoding(decodeArtifactBodyInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactBody(input))));
    on(
      artifact.apply,
      decoding(decodeArtifactApplyInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactApply(input))),
      authoring.artifact,
    );
    on(
      artifact.pending,
      decoding(decodeArtifactPendingInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactPending(input))),
    );
    on(
      artifact.labelColours,
      decoding(decodeArtifactLabelColoursInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactLabelColours(input))),
    );
    on(
      artifact.colour,
      decoding(decodeArtifactColourInput, (input) => AppRuntime.runPromise(resources.ResourceArtifactColour(input))),
      authoring.artifact,
    );
  }
  const thread = RESOURCE_IPC_CHANNELS.thread;
  if (live.task || live.artifact || live.file) {
    on(thread.list, decoding(decodeThreadListInput, (input) => AppRuntime.runPromise(resources.ResourceThreadList(input))));
    on(
      thread.post,
      decoding(decodeThreadPostInput, (input) => AppRuntime.runPromise(resources.ResourceThreadPost(input))),
      authoring.thread,
    );
  }
  return () => undefined;
};
