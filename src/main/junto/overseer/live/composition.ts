import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { CanvasNode } from "@shared/canvas";
import type { CanvasReadResult } from "@shared/ipc";
import { asNodeId, type Seat } from "@shared/model";
import { ModelActorRefs } from "../../model/actor-refs";
import { ModelService } from "../../model/service";
import { getProcessIdentityMap } from "../../process-identity";
import { SettingsService } from "../../settings/service";
import { StateEngine } from "../../state/service";
import { StationRepository } from "../../station/repository";
import { WorkProjectionReader, WorkRepository } from "../../work/repository";
import { admitOverseer } from "../admission";
import { documentOfCanvas, revisionOf } from "../portfolio";
import type { OverseerHostIdentity } from "./execution";
import { buildLiveContext } from "./context";
import { makeLiveRepository } from "./repository";
import { createLiveSessionService } from "./service";

type Services = ModelService | ModelActorRefs | SettingsService | StateEngine | SqlClient.SqlClient | StationRepository | WorkProjectionReader | WorkRepository;
export type LiveRun = <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;

/** The revision of one canvas: its sequence, as the model holds it now. */
export const canvasRevisionOf = (model: ModelService["Service"]) => (canvasName: string) =>
  model.listCanvases().pipe(Effect.flatMap((names) =>
    names.some((name) => name === canvasName)
      ? Effect.map(model.canvas(canvasName), revisionOf)
      : Effect.succeed(undefined)));

/**
 * One canvas as the live context reads it: the model's structure as a
 * document, with the task, request and artifact rows the context summarises
 * put on the nodes that hold them. The context builder still reads a document
 * (context.ts); this is the overseer's document boundary for voice, and it
 * goes with the rest of that boundary (overseer/portfolio.ts).
 */
export const readLiveCanvas = Effect.fn("Live.readCanvas")(function* (canvasName: string) {
  const model = yield* ModelService;
  const actors = yield* ModelActorRefs;
  const work = yield* WorkRepository;
  const revisions = yield* WorkProjectionReader;
  const canvas = yield* model.canvas(canvasName);
  const rows = yield* work.kernelWork(canvasName);
  const structure = documentOfCanvas(canvas);
  const nodes: Array<CanvasNode> = [];
  for (const node of structure.nodes) {
    const ether = node.ether;
    if (ether?.tasks !== undefined) {
      nodes.push({ ...node, ether: { ...ether, tasks: { ...ether.tasks, items: rows.tasks.get(node.id) ?? [] } } });
    } else if (ether?.requests !== undefined) {
      nodes.push({ ...node, ether: { ...ether, requests: { ...ether.requests, items: rows.tasks.get(node.id) ?? [] } } });
    } else if (ether?.entity?.kind === "artifacts") {
      nodes.push({ ...node, ether: { ...ether, artifacts: { items: yield* work.artifactLane(canvasName, node.id) } } });
    } else nodes.push(node);
  }
  return {
    name: canvas.name,
    doc: { ...structure, nodes },
    actorRefs: yield* actors.read(canvasName),
    revision: revisionOf(canvas),
    workRevision: yield* revisions.revision(canvasName),
  } satisfies CanvasReadResult;
});

/** The voice overseer in a seat, or nothing when the seat is not one. */
const voiceSeatOf = (node: unknown): Seat | undefined => {
  const seat = node as Seat | undefined;
  return seat?.kind === "agent" && seat.overseer && seat.harness === "junto-overseer" ? seat : undefined;
};

/** Joins Live to the already running app owners; no process or database is opened here. */
export const composeOverseerLive = async (run: LiveRun) => {
  const { sql, settings, model, work, workProjection } = await run(Effect.gen(function* () {
    return { sql: yield* SqlClient.SqlClient, settings: yield* SettingsService, model: yield* ModelService,
      work: yield* WorkRepository, workProjection: yield* WorkProjectionReader };
  }));
  const processMap = getProcessIdentityMap();
  const revisions = new Map<string, string>();
  const resolveOccupant = async (canvasName: string, nodeId: string): Promise<OverseerHostIdentity | undefined> => {
    try {
      const authority = await run(admitOverseer({ canvasName, nodeId }));
      // Voice lives on Command Center. Remote administration retains its Station owner.
      if (authority.configuration.role !== "command-center" ||
        authority.hostId !== authority.configuration.hostId) return undefined;
      const node = voiceSeatOf((await run(model.canvas(canvasName))).nodes.get(asNodeId(nodeId)));
      if (node === undefined) return undefined;
      const matches = processMap.snapshot().filter((entry) => {
        const alive = processMap.resolve(entry.pid);
        return alive !== undefined &&
          (alive.bindingId === authority.bindingId || alive.agentKey === node.agentKey) &&
          (alive.canvasName === undefined || alive.canvasName === canvasName) &&
          (alive.nodeId === undefined || alive.nodeId === nodeId);
      });
      if (matches.length !== 1) return undefined;
      const entry = matches[0]!;
      return { canvasName, nodeId, bindingId: authority.bindingId, peerPid: entry.pid,
        processGeneration: `${entry.pid}:${entry.startKey}` };
    } catch { return undefined; }
  };
  const service = createLiveSessionService({
    repository: makeLiveRepository(sql),
    canvasRevision: canvasRevisionOf(model),
    workProjection,
    run,
    settingsService: settings,
    resolveOccupant,
    contextProvider: async (attention) => {
      const read = await run(readLiveCanvas(attention.canvasName));
      revisions.set(read.name, read.revision);
      return buildLiveContext(read, attention);
    },
    targetRevision: (name) => revisions.get(name),
    subscribeAuthorityChanges: (listener, seat) => {
      // The seat as it last was. A change that takes the grant, removes the
      // seat, or leaves another agent, session or host in it ends authority.
      let seen: Seat | undefined;
      void run(model.canvas(seat.canvasName)).then((canvas) => {
        seen ??= voiceSeatOf(canvas.nodes.get(asNodeId(seat.nodeId)));
      }).catch(() => undefined);
      const unsubscribeNodes = model.subscribeChanges((event) => {
        if (event.canvas !== seat.canvasName) return;
        if (event.removedNodes.some((id) => id === seat.nodeId)) return listener(undefined);
        const changed = event.nodes.find((node) => node.id === seat.nodeId);
        if (changed === undefined) return;
        const next = voiceSeatOf(changed);
        const previous = seen;
        seen = next;
        if (next === undefined || previous === undefined ||
          next.bindingId !== previous.bindingId || next.agentKey !== previous.agentKey ||
          next.host !== previous.host) listener(undefined);
      });
      const unsubscribeCanvases = model.subscribeCanvasesChanges((event) => {
        if (event._tag === "Removed" && event.canvas === seat.canvasName) listener(undefined);
      });
      const unsubscribeCanvas = () => { unsubscribeNodes(); unsubscribeCanvases(); };
      const unsubscribeProcess = processMap.subscribe((principal) => {
        // Lifecycle events are unbinds. Latch them synchronously, even if a later
        // bind occupies the same seat before an asynchronous re-admission runs.
        if (principal.canvasName === seat.canvasName && principal.nodeId === seat.nodeId) listener(undefined);
      });
      return () => { unsubscribeCanvas(); unsubscribeProcess(); };
    },
  });
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = (): void => {
    if (refresh !== undefined) return;
    refresh = setTimeout(() => {
      refresh = undefined;
      void service.refreshContext().catch(() => undefined);
    }, 250);
  };
  const unsubscribes = [
    model.subscribeChanges((event, current) => {
      revisions.set(event.canvas, revisionOf(current));
      refreshSoon();
    }),
    model.subscribeCanvasesChanges((event) => {
      if (event._tag === "Removed") revisions.set(event.canvas, "deleted");
      refreshSoon();
    }),
    // Work moves without the canvas changing; the context shows both.
    work.subscribeChanges(() => refreshSoon()),
  ];
  const unsubscribe = (): void => { for (const stop of unsubscribes) stop(); };
  try { await service.liveSnapshot(); } catch (error) { unsubscribe(); await service.dispose(); throw error; }
  return {
    ...service,
    dispose: async (): Promise<void> => {
      unsubscribe();
      clearTimeout(refresh);
      await service.dispose();
    },
  };
};
