import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { asNodeId, type Canvas, type Seat } from "@shared/model";
import { ModelActorRefs } from "../../model/actor-refs";
import { ModelService } from "../../model/service";
import { getProcessIdentityMap } from "../../process-identity";
import { SettingsService } from "../../settings/service";
import { StateEngine } from "../../state/service";
import { withSqlRead } from "../../state/sql-read";
import { StationRepository } from "../../station/repository";
import { WorkRevisions, WorkRepository } from "../../work/repository";
import { admitOverseer } from "../admission";
import type { OverseerHostIdentity } from "./execution";
import { buildLiveContext, type LiveCanvasRead } from "./context";
import { makeLiveRepository } from "./repository";
import { createLiveSessionService } from "./service";

type Services = ModelService | ModelActorRefs | SettingsService | StateEngine | SqlClient.SqlClient | StationRepository | WorkRevisions | WorkRepository;
export type LiveRun = <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;

/** A canvas revision as the live journal keeps it: the sequence, as text. */
export const revisionOf = (canvas: Canvas): string => String(canvas.seq);

/** The revision of one canvas: its sequence, as the model holds it now. */
export const canvasRevisionOf = (model: ModelService["Service"]) => (canvasName: string) =>
  model.listCanvases().pipe(Effect.flatMap((names) =>
    names.some((name) => name === canvasName)
      ? Effect.map(model.canvas(canvasName), revisionOf)
      : Effect.succeed(undefined)));

/**
 * One canvas as the live context reads it: the model's structure, and beside
 * it the task, request and artifact rows the context summarises.
 */
export const readLiveCanvas = Effect.fn("Live.readCanvas")(function* (canvasName: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withSqlRead(sql, Effect.gen(function* () {
    const model = yield* ModelService;
    const work = yield* WorkRepository;
    const revisions = yield* WorkRevisions;
    const canvas = yield* model.canvas(canvasName);
    const rows = yield* work.kernelWork(canvasName);
    const artifacts = new Map<string, ReadonlyArray<string>>();
    for (const node of canvas.nodes.values()) {
      if (node.kind !== "artifacts") continue;
      artifacts.set(
        node.id,
        yield* work.artifactIds(canvasName, node.id),
      );
    }
    return {
      name: canvas.name,
      canvas,
      tasks: rows.tasks,
      artifacts,
      revision: revisionOf(canvas),
      workRevision: yield* revisions.revision(canvasName),
    } satisfies LiveCanvasRead;
  }));
});

/** The voice overseer in a seat, or nothing when the seat is not one. */
const voiceSeatOf = (node: unknown): Seat | undefined => {
  const seat = node as Seat | undefined;
  return seat?.kind === "agent" && seat.overseer && seat.harness === "junto-overseer" ? seat : undefined;
};

/** Joins Live to the already running app owners; no process or database is opened here. */
export const composeOverseerLive = async (run: LiveRun) => {
  const { sql, settings, model, work, workRevisions } = await run(Effect.gen(function* () {
    return { sql: yield* SqlClient.SqlClient, settings: yield* SettingsService, model: yield* ModelService,
      work: yield* WorkRepository, workRevisions: yield* WorkRevisions };
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
    workRevisions,
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
