/**
 * Owner-local Remote adapter for starting one managed actor seat from the
 * active installed projection.
 *
 * The caller names only a canvas/node reference. Binding, harness, agent key,
 * launch argv, placement, and installation authority all come from the
 * projection owned by CanvasesService and StationRepository.
 */

import { Effect } from "effect";
import { CanvasesService } from "../canvases";
import { StationRepository } from "../station/repository";
import type { TerminalSessionSummary } from "@shared/terminal";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { CanvasReadResult } from "@shared/ipc";
import type { InstallationId } from "@shared/installation-id";
import type { ActorRef } from "@shared/work-protocol";
import type { LocalSessionHost, LocalHostAgentSeatInput } from "./local-host";
import { isManagedSeatRuntimeLocal } from "./ensure-managed-seat";
import { launchForManagedSpawn } from "./managed-spawn-plan";

export type ProjectedAgentCreateInput = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly cols?: number;
  readonly rows?: number;
};

export type ProjectedAgentRuntimeAuthority = {
  readonly installationId: InstallationId;
  readonly hostId: string;
};

const exactActorRef = (
  actorRefs: ReadonlyArray<ActorRef>,
  canvasName: string,
  nodeId: string,
): ActorRef | undefined => {
  const matches = actorRefs.filter(
    (actor) =>
      actor.canvasName === canvasName &&
      actor.nodeId === nodeId,
  );
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * Resolve the exact LocalSessionHost actor input without opening state or
 * accepting launch authority from the caller.
 */
export const resolveProjectedAgentSeatInput = (
  read: CanvasReadResult,
  authority: ProjectedAgentRuntimeAuthority,
  input: ProjectedAgentCreateInput,
): LocalHostAgentSeatInput => {
  if (read.name !== input.canvasName) {
    throw new Error("projected agent canvas identity mismatch");
  }
  const nodes = read.doc.nodes.filter((node) => node.id === input.nodeId);
  if (nodes.length !== 1) {
    throw new Error(
      `projected agent ${JSON.stringify(input.nodeId)} is not exactly one node`,
    );
  }
  const node = nodes[0]!;
  const actor = exactActorRef(
    read.actorRefs,
    input.canvasName,
    input.nodeId,
  );
  if (actor === undefined) {
    throw new Error(
      `projected node ${JSON.stringify(input.nodeId)} is not exactly one compiled actor seat`,
    );
  }
  if (
    !isManagedSeatRuntimeLocal(input.canvasName, node, {
      actor,
      installationId: authority.installationId,
      hostId: authority.hostId,
    })
  ) {
    throw new Error(
      `projected actor ${JSON.stringify(input.nodeId)} is not local to this Remote`,
    );
  }
  const surface = actorDeliverySurfaceOf(node);
  if (surface?._tag !== "managedAgent") {
    throw new Error(
      `projected node ${JSON.stringify(input.nodeId)} has no managed agent surface`,
    );
  }
  const planned = launchForManagedSpawn({
    doc: read.doc,
    nodeId: node.id,
    harness: surface.harness,
    documentLaunch: surface.launch,
    agentKey: surface.agentKey,
    cwd: surface.launch?.cwd,
    resume: true,
  });
  const launch = planned.launch ?? surface.launch;
  const label = node.ether?.terminal?.label;
  return {
    bindingId: surface.bindingId,
    hostId: surface.hostId,
    canvasName: input.canvasName,
    nodeId: node.id,
    harness: surface.harness,
    agentKey: surface.agentKey,
    ...(launch === undefined ? {} : { launch }),
    ...(label === undefined ? {} : { label }),
    ...(input.cols === undefined ? {} : { cols: input.cols }),
    ...(input.rows === undefined ? {} : { rows: input.rows }),
    ...(planned.plan?.firstTypedMessage
      ? { firstTypedMessage: planned.plan.firstTypedMessage }
      : {}),
  };
};

/**
 * Product service adapter. State remains behind Effect services; the Term UDS
 * never opens SQLite or receives a caller-supplied identity/launch payload.
 */
export const createProjectedAgentSeat = (
  host: LocalSessionHost,
  input: ProjectedAgentCreateInput,
): Effect.Effect<
  TerminalSessionSummary,
  unknown,
  CanvasesService | StationRepository
> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const stations = yield* StationRepository;
    const [read, configuration, installationId] = yield* Effect.all([
      canvases.read(input.canvasName),
      stations.configuration,
      stations.installationId,
    ]);
    if (
      configuration === undefined ||
      configuration.configuration.role !== "remote"
    ) {
      return yield* Effect.fail(
        new Error("projected agent creation is available only on a configured Remote"),
      );
    }
    const seatInput = yield* Effect.try({
      try: () =>
        resolveProjectedAgentSeatInput(
          read,
          {
            installationId,
            hostId: configuration.configuration.hostId,
          },
          input,
        ),
      catch: (error) => error,
    });
    return host.createAgentSeat(seatInput);
  });
