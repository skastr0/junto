import { Effect } from "effect";
import { isManagedAgentNode } from "@shared/actor-surface";
import { serializeCanvas } from "@shared/canvas";
import type { LiveAttention } from "@shared/overseer-live";
import { resolveNodeHostId } from "@shared/station";
import { CanvasesService } from "../../canvases";
import { canvasBodySha256Of } from "../../canvas-intent-identity";
import { getProcessIdentityMap } from "../../process-identity";
import { SettingsService } from "../../settings/service";
import { StateEngine } from "../../state/service";
import { StationRepository } from "../../station/repository";
import { admitOverseer } from "../admission";
import type { OverseerHostIdentity } from "./execution";
import { buildLiveContext } from "./context";
import { makeLiveRepository } from "./repository";
import { createLiveSessionService } from "./service";

type Services = CanvasesService | SettingsService | StateEngine | StationRepository;
export type LiveRun = <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;

/** Joins Live to the already running app owners; no process or database is opened here. */
export const composeOverseerLive = async (run: LiveRun) => {
  const { state, settings, canvases } = await run(Effect.gen(function* () {
    return { state: yield* StateEngine, settings: yield* SettingsService, canvases: yield* CanvasesService };
  }));
  const processMap = getProcessIdentityMap();
  const revisions = new Map<string, string>();
  let latestAttention: LiveAttention | undefined;
  const resolveOccupant = async (canvasName: string, nodeId: string): Promise<OverseerHostIdentity | undefined> => {
    try {
      const authority = await run(admitOverseer({ canvasName, nodeId }));
      // Voice lives on Command Center. Remote administration retains its Station owner.
      if (authority.configuration.role !== "command-center" ||
        authority.hostId !== authority.configuration.hostId) return undefined;
      const read = await run(canvases.read(canvasName, "overseer.canvas"));
      const node = read.doc.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || !isManagedAgentNode(node) || node.ether.terminal.harness !== "vellum-overseer") return undefined;
      const matches = processMap.snapshot().filter((entry) => {
        const alive = processMap.resolve(entry.pid);
        return alive !== undefined &&
          (alive.bindingId === authority.bindingId || alive.agentKey === node.ether.entity.name) &&
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
    repository: makeLiveRepository(state),
    run,
    settingsService: settings,
    resolveOccupant,
    contextProvider: async (attention) => {
      const read = await run(canvases.read(attention.canvasName, "overseer.canvas"));
      revisions.set(read.name, read.revision);
      latestAttention = structuredClone(attention);
      return buildLiveContext(read, attention);
    },
    targetRevision: (name) => revisions.get(name),
    subscribeAuthorityChanges: (listener, seat) => {
      const unsubscribeCanvas = canvases.subscribeChanges((name, detail) => {
        if (name !== seat.canvasName || !detail) return;
        const previous = detail.previous?.nodes.find((node) => node.id === seat.nodeId);
        const next = detail.next?.nodes.find((node) => node.id === seat.nodeId);
        if (!next || !previous || !isManagedAgentNode(next) || !isManagedAgentNode(previous) ||
          next.ether.overseer !== true || next.ether.terminal.harness !== "vellum-overseer" ||
          next.ether.terminal.bindingId !== previous.ether.terminal.bindingId ||
          next.ether.entity.name !== previous.ether.entity.name ||
          resolveNodeHostId(next) !== resolveNodeHostId(previous)) listener(undefined);
      });
      const unsubscribeProcess = processMap.subscribe((principal) => {
        // Lifecycle events are unbinds. Latch them synchronously, even if a later
        // bind occupies the same seat before an asynchronous re-admission runs.
        if (principal.canvasName === seat.canvasName && principal.nodeId === seat.nodeId) listener(undefined);
      });
      return () => { unsubscribeCanvas(); unsubscribeProcess(); };
    },
  });
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = canvases.subscribeChanges((name, detail) => {
    if (detail) revisions.set(name, detail.next ? canvasBodySha256Of(serializeCanvas(detail.next)) : "deleted");
    if (latestAttention?.canvasName !== name || refresh !== undefined) return;
    refresh = setTimeout(() => {
      refresh = undefined;
      const attention = latestAttention;
      if (!attention) return;
      void service.liveSnapshot().then((snapshot) => snapshot.sessionId && snapshot.connection === "ready"
        ? service.liveAttention(snapshot.sessionId, attention) : undefined).catch(() => undefined);
    }, 250);
  });
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
