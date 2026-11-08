/**
 * The core's handlers of the resources group (src/contract/core/resources.ts):
 * the renderer's tasks, artifacts and their threads, every read from the same
 * ports the CLI verbs use and every write one ResourceCommand submitted to the
 * same ruler. Main has already decoded the renderer's payload closed.
 *
 * A change is told to the window from the core's own notice
 * (`onResourceChanged`, `onThreadChanged`), so a write made by any surface
 * reaches the window, not only one made here. The notices are heard for as
 * long as this Layer lives, and main relays both onto the channels the window
 * listens to.
 */
import { Effect } from "effect";
import { RESOURCE_IPC_CHANNELS } from "@shared/resource-ipc";
import {
  RESOURCE_CHANGED,
  RESOURCE_THREAD_CHANGED,
  type ResourceChangedPush,
  type ResourceThreadChangedPush,
} from "../../contract/core/channels";
import { ResourcesRpcs, ResourceUnavailable } from "../../contract/core/resources";
import { CorePushes } from "../push";
import { onResourceChanged, onThreadChanged } from "../work/resource-changes";
import {
  allTasks,
  applyArtifact,
  applyTask,
  artifactBody,
  artifactHistory,
  artifactLabelColours,
  artifactMoves,
  colourArtifactLabel,
  listArtifacts,
  listTasks,
  listThreads,
  pendingArtifacts,
  pendingTasks,
  postThread,
  taskContext,
} from "../work/resource-ipc";
import { workResourcePorts as withPorts } from "../work/resource-ports";

/** A read the store could not make, as the contract names it: what the store said. */
const unavailable = <A, E extends { readonly message: string }, R>(read: Effect.Effect<A, E, R>) =>
  Effect.mapError(read, (error) => new ResourceUnavailable({ message: error.message }));

export const ResourcesHandlers = ResourcesRpcs.toLayer(
  Effect.gen(function* () {
    const pushes = yield* CorePushes;
    const publishing = Effect.runForkWith(yield* Effect.context<never>());

    // The notices a write leaves. Told from here so any surface's write reaches
    // the window; main relays both onto the channels the window listens to.
    const stopResourceNotice = onResourceChanged((domain, canvasName, _artifact, nodeIds) => {
      publishing(
        pushes.publish(RESOURCE_CHANGED, {
          channel: RESOURCE_IPC_CHANNELS[domain].changed,
          canvasName,
          // Named nodes go on as named; none means the whole canvas.
          ...(nodeIds === undefined ? {} : { nodeIds }),
        } satisfies ResourceChangedPush),
      );
      // A comment on a task or an artifact is a change of it (subject-comment.ts),
      // so its threads moved too: the thread pane reads again, as the
      // in-process notice tells it (work/resource-ipc.ts).
      publishing(
        pushes.publish(RESOURCE_THREAD_CHANGED, {
          channel: RESOURCE_IPC_CHANNELS.thread.changed,
          canvasName,
          kind: domain,
        } satisfies ResourceThreadChangedPush),
      );
    });
    const stopThreadNotice = onThreadChanged((kind, canvasName) => {
      publishing(
        pushes.publish(RESOURCE_THREAD_CHANGED, {
          channel: RESOURCE_IPC_CHANNELS.thread.changed,
          canvasName,
          kind,
        } satisfies ResourceThreadChangedPush),
      );
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopResourceNotice();
        stopThreadNotice();
      }),
    );

    return {
      ResourceTaskList: ({ canvasName, nodeId }) =>
        unavailable(withPorts((ports) => listTasks(ports, canvasName, nodeId))),
      ResourceTaskAll: ({ canvasName }) => unavailable(withPorts((ports) => allTasks(ports, canvasName))),
      ResourceTaskContext: ({ canvasName }) => unavailable(withPorts((ports) => taskContext(ports, canvasName))),
      ResourceTaskApply: ({ canvasName, nodeId, taskId, opId, command }) =>
        withPorts((ports) => applyTask(ports, canvasName, nodeId, taskId, opId, command)),
      ResourceTaskPending: ({ canvasName, nodeId }) =>
        unavailable(withPorts((ports) => pendingTasks(ports, canvasName, nodeId))),
      ResourceArtifactList: ({ canvasName, nodeId }) =>
        unavailable(withPorts((ports) => listArtifacts(ports, canvasName, nodeId))),
      ResourceArtifactHistory: ({ canvasName, artifactId }) =>
        unavailable(withPorts((ports) => artifactHistory(ports, canvasName, artifactId))),
      ResourceArtifactMoves: ({ canvasName, artifactId }) =>
        unavailable(withPorts((ports) => artifactMoves(ports, canvasName, artifactId))),
      ResourceArtifactBody: ({ canvasName, artifactId, version }) =>
        unavailable(withPorts((ports) => artifactBody(ports, canvasName, artifactId, version))),
      ResourceArtifactApply: ({ canvasName, nodeId, artifactId, opId, op }) =>
        withPorts((ports) => applyArtifact(ports, canvasName, nodeId, artifactId, opId, op)),
      ResourceArtifactPending: ({ canvasName, nodeId }) =>
        unavailable(withPorts((ports) => pendingArtifacts(ports, canvasName, nodeId))),
      ResourceArtifactLabelColours: ({ canvasName, nodeId }) =>
        unavailable(withPorts((ports) => artifactLabelColours(ports, canvasName, nodeId))),
      ResourceArtifactColour: ({ canvasName, nodeId, opId, label, colour }) =>
        withPorts((ports) => colourArtifactLabel(ports, canvasName, nodeId, opId, label, colour)),
      ResourceThreadList: ({ canvasName, subject }) =>
        unavailable(withPorts((ports) => listThreads(ports, canvasName, subject))),
      ResourceThreadPost: ({ canvasName, subject, post }) =>
        withPorts((ports) => postThread(ports, canvasName, subject, post)),
    };
  }),
);
