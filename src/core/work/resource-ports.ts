/**
 * The resource ports, built on the work service the core holds: a canvas read
 * and a node's comments, both read only. Every resource operation runs on
 * these, whether it answers the window or the overseer.
 */
import { Effect } from "effect";
import type { ResourceIpcPorts } from "./resource-ipc";
import { liveResourceIpcPorts } from "./resource-ipc";
import { WorkService } from "./service";

export const workResourcePorts = <A, E>(
  use: (ports: ResourceIpcPorts) => Effect.Effect<A, E>,
): Effect.Effect<A, E, WorkService> =>
  Effect.map(WorkService, (work) =>
    liveResourceIpcPorts(
      (canvasName: string) =>
        work.readTopology(canvasName).pipe(
          Effect.map((read) => read.canvas),
          Effect.mapError(() => ({
            type: "InternalError" as const,
            message: `canvas ${canvasName} could not be read`,
            details: { retryable: true },
          })),
        ),
      (canvasName: string, nodeId: string) =>
        work.readMailbox(canvasName, nodeId).pipe(
          Effect.mapError(() => ({
            type: "InternalError" as const,
            message: `the comments on ${nodeId} could not be read`,
            details: { retryable: true },
          })),
        ),
    ),
  ).pipe(Effect.flatMap(use));
