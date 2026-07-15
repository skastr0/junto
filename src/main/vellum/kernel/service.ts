// KernelService — the Effect Tag + Live layer that runs kernel evaluation
// continuously over EVERY hydrated canvas, window-optional. This module owns
// lifecycle (hydration, doc resync, the 30s safety interval), binds cycle.ts's
// injectable seams to concrete main-side collaborators (ChatService,
// CanvasesService, StoreService, the tower-browse adapter), and persists
// arming through StoreService. See kernel-design.md for the full design.
//
// cycle.ts/evaluate.ts are the pure loop + evaluator (ported verbatim from
// the renderer in an earlier batch); this file is the only thing that binds
// their `__*ForTest`-named seams to something real. Despite the name, those
// setters ARE the production injection points — cycle.ts exposes no
// separately-named "prod" variant, by design (kernel-design.md §2, §7).

import { Context, Effect, Layer } from "effect";
import type { CanvasDoc, CanvasNode, EtherFlag } from "@shared/canvas";
import type { ServiceCheck } from "@shared/contracts";
import type {
  ArmRegionResult,
  BindingHint,
  KernelSnapshot,
  PulseRecord,
  TowerBrowseResult,
  TowerGlyphRow,
  WatcherRuntimeState,
} from "@shared/ipc";
import { fetchTowerBrowse } from "../adapters/tower-browse";
import { CanvasesService } from "../canvases";
import type { ChatService } from "../chat/service";
import { SnapshotsService } from "../snapshots";
import { StoreService } from "../../services/store";
import {
  checkTimers,
  deliverPulse,
  getArmed,
  getExecutionByCanvas,
  getNextFire,
  getPulseLog,
  getWatchers,
  purgeCanvasMemory,
  reconcileLiveCanvasMemory,
  runEvaluationCycle,
  setArmed,
  setDocs,
  __setDeliveryDepsForTest,
  __setFlagWriterForTest,
  __setGlyphFetcherForTest,
  __setSnapshotsForTest,
} from "./cycle";

export interface PulseRegionOptions {
  readonly dry?: boolean;
  readonly summary?: string;
}

export class KernelService extends Context.Tag("@vellum/KernelService")<
  KernelService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    // Begin hydration + the evaluation loop. Idempotent, matching
    // CanvasesService.start()/SnapshotsService.start().
    readonly start: () => void;
    // Synchronous read of the current wire snapshot — used for getKernelState's
    // initial-hydrate answer.
    readonly getSnapshot: () => KernelSnapshot;
    readonly armRegion: (canvasName: string, regionId: string, armed: boolean) => Effect.Effect<ArmRegionResult>;
    readonly pulseRegion: (
      canvasName: string,
      regionId: string,
      opts?: PulseRegionOptions,
    ) => Effect.Effect<void>;
    // Pushed on cycle end + on arming/pulse changes — never per-watcher.
    readonly subscribe: (listener: (snapshot: KernelSnapshot) => void) => () => void;
    // A kernel flag mutate() is an "own write" CanvasesService suppresses from
    // its normal file-watch broadcast, so callers that also need canvasChanged
    // pushes for live-view coherence subscribe here separately.
    readonly subscribeCanvasMutated: (listener: (name: string) => void) => () => void;
  }
>() {}

const SAFETY_INTERVAL_MS = 30_000;
// Short poll purely for "did the off-cycle delivery queue append a record
// since we last pushed" — deliverPulse's queue (cycle.ts) drains
// fire-and-forget, off the evaluation cycle's critical path, with no
// completion hook exposed. Without this, a watcher-fired (as opposed to
// manual pulseRegion) delivery would only become visible to the renderer at
// the next full cycle (worst case SAFETY_INTERVAL_MS later). Cheap: just an
// array-length comparison, no evaluation work.
const PULSE_LOG_POLL_MS = 3_000;
const GLYPH_CACHE_TTL_MS = 15_000;
const ARMED_STORE_KEY = "kernel.armed";
const KNOWN_FLAGS: ReadonlySet<string> = new Set(["blocker", "parked", "attention"]);

const armedStoreKey = (canvasName: string, regionId: string): string => `${canvasName}::${regionId}`;

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

// Pure doc transform mirroring renderer/lib/mutations.ts's toggleFlag,
// specialized to the kernel's flag-mirror use: an unrecognized flag value
// never mutates the document (reject illegitimate input rather than
// silently coercing it).
const toggleFlagInDoc = (doc: CanvasDoc, nodeId: string, flag: string): CanvasDoc => {
  if (!KNOWN_FLAGS.has(flag)) return doc;
  const etherFlag = flag as EtherFlag;
  return {
    ...doc,
    nodes: doc.nodes.map((node): CanvasNode => {
      if (node.id !== nodeId) return node;
      const flags = node.ether?.flags ?? [];
      const has = flags.includes(etherFlag);
      const nextFlags = has ? flags.filter((f) => f !== etherFlag) : [...flags, etherFlag];
      if (nextFlags.length > 0) {
        return { ...node, ether: { ...(node.ether ?? {}), flags: nextFlags } };
      }
      if (!node.ether) return node;
      const nextEther = without(node.ether, "flags");
      return Object.keys(nextEther).length > 0
        ? { ...node, ether: nextEther }
        : (without(node, "ether") as CanvasNode);
    }),
  };
};

// Every ether binding across every hydrated canvas, deduped — the union the
// snapshot poll needs so a stat_threshold watcher on ANY watched canvas is
// never blind to that project's live data, not just the one open in a window.
const unionHints = (docs: ReadonlyMap<string, CanvasDoc>): ReadonlyArray<BindingHint> => {
  const seen = new Set<string>();
  const hints: BindingHint[] = [];
  for (const doc of docs.values()) {
    for (const node of doc.nodes) {
      for (const binding of node.ether?.bindings ?? []) {
        const key = `${binding.source}:${binding.ref.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({ source: binding.source, key: binding.ref.key });
      }
    }
  }
  return hints;
};

// Splits a `${canvasName}::${id}` module-memory key back into its parts.
// Canvas names are restricted to [a-z0-9-] (canvases.ts NAME_PATTERN) and
// node/region ids never contain "::", so the first occurrence is always the
// namespace boundary.
const splitNamespacedKey = (key: string): readonly [canvasName: string, id: string] | undefined => {
  const idx = key.indexOf("::");
  if (idx < 0) return undefined;
  return [key.slice(0, idx), key.slice(idx + 2)];
};

// Durable-intent invariant: an armed key whose canvas or region no longer
// exists in any hydrated document is ORPHANED — the arm-intent stays in the
// store and is surfaced in the snapshot; it is never silently dropped. With
// zero docs hydrated (early startup) no judgment is possible, so none is made.
export const computeOrphanedArming = (
  docs: ReadonlyMap<string, CanvasDoc>,
  armed: Iterable<readonly [string, boolean]>,
): ReadonlyArray<string> => {
  if (docs.size === 0) return [];
  const orphaned: string[] = [];
  for (const [key, value] of armed) {
    if (!value) continue;
    const split = splitNamespacedKey(key);
    if (!split) continue;
    const doc = docs.get(split[0]);
    if (!doc || !doc.nodes.some((node) => node.id === split[1])) orphaned.push(key);
  }
  return orphaned;
};

// Pure decision: given a fresh tower-browse result and the previous cache
// entry (if any), what should the durable cache now hold, and what rows
// should THIS call return. A partial read (some, not all, of the 5 fanned-
// out orbit requests failed) must never be treated as authoritative for
// edge decisions — a glyphs_done/glyphs_entered_state watcher fed a partial
// read could see fewer done glyphs than reality and suppress or mis-time a
// fire. So: prefer a prior COMPLETE cache entry over the fresh partial one;
// with no prior cache, fall through to `undefined` (matches "glyph data
// unavailable" -> unknown in evaluate.ts) rather than let the watcher
// evaluate against data already known to be incomplete. Partial rows are
// NEVER written to the durable cache either, so they can never clobber a
// real complete snapshot or be mistaken for one on a later TTL-expired read.
export const resolveGlyphCacheUpdate = (
  fresh: TowerBrowseResult,
  cached: { readonly rows: ReadonlyArray<TowerGlyphRow> } | undefined,
): { readonly rows: ReadonlyArray<TowerGlyphRow> | undefined; readonly cacheWrite: ReadonlyArray<TowerGlyphRow> | undefined } => {
  if (!fresh.ok) return { rows: cached?.rows, cacheWrite: undefined };
  if (fresh.partial) return { rows: cached?.rows, cacheWrite: undefined };
  return { rows: fresh.glyphs, cacheWrite: fresh.glyphs };
};

type CanvasesShape = Context.Tag.Service<typeof CanvasesService>;
type SnapshotsShape = Context.Tag.Service<typeof SnapshotsService>;
type StoreShape = Context.Tag.Service<typeof StoreService>;
type KernelServiceShape = Context.Tag.Service<typeof KernelService>;

const makeKernelService = (
  canvases: CanvasesShape,
  snapshots: SnapshotsShape,
  store: StoreShape,
  chatService: ChatService,
): KernelServiceShape => {
  const docs = new Map<string, CanvasDoc>();
  const glyphCache = new Map<string, { readonly at: number; readonly rows: ReadonlyArray<TowerGlyphRow> }>();
  const snapshotListeners = new Set<(snapshot: KernelSnapshot) => void>();
  const canvasMutatedListeners = new Set<(name: string) => void>();

  let started = false;
  let armingFault: string | undefined;
  let cycleInFlight = false;
  let cycleQueued = false;
  let lastPulseLogLength = 0;

  const composeSnapshot = (): KernelSnapshot => {
    const canvasesOut: Record<
      string,
      {
        watchers: Record<string, WatcherRuntimeState>;
        armed: Record<string, boolean>;
        nextFire: Record<string, number>;
        execution?: import("./cycle").ExecutionSnapshot;
      }
    > = {};
    const entryFor = (name: string) => (canvasesOut[name] ??= { watchers: {}, armed: {}, nextFire: {} });
    for (const name of docs.keys()) {
      const entry = entryFor(name);
      const execution = getExecutionByCanvas().get(name);
      if (execution) entry.execution = execution;
    }
    for (const [key, value] of getWatchers()) {
      const split = splitNamespacedKey(key);
      if (!split) continue;
      entryFor(split[0]).watchers[split[1]] = value;
    }
    for (const [key, value] of getNextFire()) {
      const split = splitNamespacedKey(key);
      if (!split) continue;
      entryFor(split[0]).nextFire[split[1]] = value;
    }
    for (const [key, value] of getArmed()) {
      if (!value) continue;
      const split = splitNamespacedKey(key);
      if (!split) continue;
      // An armed key whose canvas is not hydrated (deleted in-session, but the
      // arm-intent is deliberately preserved in memory — cycle.ts's
      // purgeCanvasMemory no longer drops it) must NOT conjure a phantom
      // healthy canvas entry here. It surfaces via orphanedArming instead.
      if (!docs.has(split[0])) continue;
      entryFor(split[0]).armed[split[1]] = value;
    }
    const orphanedArming = computeOrphanedArming(docs, getArmed());
    return {
      canvases: canvasesOut,
      pulseLog: getPulseLog() as ReadonlyArray<PulseRecord>,
      ...(armingFault !== undefined ? { fault: armingFault } : {}),
      ...(orphanedArming.length > 0 ? { orphanedArming } : {}),
    };
  };

  const emitSnapshot = (): void => {
    const snapshot = composeSnapshot();
    lastPulseLogLength = snapshot.pulseLog.length;
    for (const listener of snapshotListeners) listener(snapshot);
    // Best-effort file-based mirror for headless observability (the probe
    // and any other external, IPC-less tooling): bounded tail, never blocks
    // or fails the push on a store write hiccup.
    void Effect.runPromise(
      store.set("kernel.debug", { pulseLog: snapshot.pulseLog.slice(-20) }),
    ).catch(() => undefined);
  };

  // --- glyph fetcher: TTL-cached tower-browse ---------------------------------
  const cachedGlyphFetcher = async (project: string): Promise<ReadonlyArray<TowerGlyphRow> | undefined> => {
    const cached = glyphCache.get(project);
    if (cached && Date.now() - cached.at < GLYPH_CACHE_TTL_MS) return cached.rows;
    try {
      const result = await fetchTowerBrowse(project);
      const { rows, cacheWrite } = resolveGlyphCacheUpdate(result, cached);
      if (cacheWrite !== undefined) glyphCache.set(project, { at: Date.now(), rows: cacheWrite });
      return rows;
    } catch {
      return cached?.rows;
    }
  };
  __setGlyphFetcherForTest(cachedGlyphFetcher);

  // --- delivery: the shared main-side ChatService -----------------------------
  __setDeliveryDepsForTest({
    isLive: (agentKey) => chatService.isLive(agentKey),
    openChat: async (agentKey) => {
      const result = await chatService.chatOpen(agentKey);
      if (!result.ok) throw new Error(result.error);
    },
    sendPrompt: async (agentKey, message, contextBlocks) => {
      const result = await chatService.chatPrompt(agentKey, message, contextBlocks);
      if (!result.ok) throw new Error(result.error);
    },
  });

  // --- flag mirror: CanvasesService.mutate, routed by (canvasName, nodeId).
  // The evaluator that fires a flag write always knows which canvas the node
  // came from (evaluation iterates per-doc), so cycle.ts threads canvasName
  // through FlagWriterDeps.toggleFlag directly — no node->canvas reverse
  // index, and therefore no cross-canvas collision to disambiguate. JSON
  // Canvas node ids are document-local by spec; the same id on two canvases
  // now routes to the right document instead of being safe-dropped.
  __setFlagWriterForTest({
    toggleFlag: (canvasName, nodeId, flag) => {
      void Effect.runPromise(canvases.mutate(canvasName, (doc) => toggleFlagInDoc(doc, nodeId, flag)))
        .then(() => Effect.runPromise(Effect.either(canvases.read(canvasName))))
        .then((result) => {
          if (result._tag === "Right") docs.set(canvasName, result.right.doc);
          for (const listener of canvasMutatedListeners) listener(canvasName);
          emitSnapshot();
        })
        .catch((err) => console.error(`[kernel] flag write failed for ${canvasName}/${nodeId}:`, err));
    },
  });

  // --- evaluation cycle --------------------------------------------------------

  const runCycle = async (): Promise<void> => {
    __setSnapshotsForTest(await Effect.runPromise(snapshots.current));
    await Promise.all([runEvaluationCycle(), checkTimers()]);
    // Sweep stale watcher/timer runtime entries for nodes removed on a still-
    // existing canvas (whole-canvas deletes are handled by purgeCanvasMemory
    // on resync). Runs after evaluation so this cycle's fresh entries stand.
    reconcileLiveCanvasMemory();
    emitSnapshot();
  };

  // Coalesces overlapping triggers (snapshot change + doc change + the
  // safety interval can all fire close together) into at most one queued
  // rerun — never two concurrent cycles racing shared edge-detection memory.
  // Ported from renderer/lib/kernel-state.ts's scheduleCycle.
  const scheduleCycle = (): void => {
    if (cycleInFlight) {
      cycleQueued = true;
      return;
    }
    cycleInFlight = true;
    void runCycle()
      .catch((err) => console.error("[kernel] evaluation cycle failed:", err))
      .finally(() => {
        cycleInFlight = false;
        if (cycleQueued) {
          cycleQueued = false;
          scheduleCycle();
        }
      });
  };

  // --- doc hydration + mid-cycle resync ---------------------------------------

  const hydrateDoc = async (name: string): Promise<void> => {
    const result = await Effect.runPromise(Effect.either(canvases.read(name)));
    if (result._tag === "Right") docs.set(name, result.right.doc);
    // else: a broken/mid-write canvas is skipped this pass — one bad doc
    // never stalls hydration of the rest.
  };

  // Bounded, like cycle.ts's own MAX_CONCURRENT_GLYPH_FETCHES batching — a
  // station can accumulate many canvases; hydration must not fan out one
  // unbounded Promise.all across all of them at once.
  const MAX_CONCURRENT_HYDRATIONS = 4;

  const hydrateAllDocs = async (): Promise<void> => {
    const summaries = await Effect.runPromise(canvases.list);
    for (let i = 0; i < summaries.length; i += MAX_CONCURRENT_HYDRATIONS) {
      const batch = summaries.slice(i, i + MAX_CONCURRENT_HYDRATIONS);
      await Promise.all(batch.map((summary) => hydrateDoc(summary.name)));
    }
    setDocs(docs);
  };

  // create/external-edit -> reread into the map; delete -> drop + purge its
  // namespaced in-memory state. subscribeChanges only reports a name, not
  // the kind of change, so list() is the source of truth for "still there".
  const resyncCanvas = async (name: string): Promise<void> => {
    const summaries = await Effect.runPromise(canvases.list);
    if (!summaries.some((summary) => summary.name === name)) {
      docs.delete(name);
      purgeCanvasMemory(name);
      scheduleCycle();
      return;
    }

    const result = await Effect.runPromise(Effect.either(canvases.read(name)));
    if (result._tag === "Right") {
      docs.set(name, result.right.doc);
      void Effect.runPromise(snapshots.refresh(unionHints(docs)));
      scheduleCycle();
    }
    // else: transient read/decode failure (e.g. mid-write) — keep the
    // previously hydrated doc; the next external-edit event retries.
  };

  // --- arming: StoreService-persisted, cycle.ts's in-memory map is the hot read

  // Durable-intent invariant: a store that cannot be READ must not boot the
  // kernel silently disarmed — that is a silent disarm wearing an error's
  // clothes. On load failure the fault is surfaced in every snapshot, armed
  // regions are explicitly NOT resumed, and nothing is overwritten (store.set
  // reads first, so the corrupt file also cannot be clobbered by later
  // writes). The kernel itself keeps running.
  const hydrateArming = async (): Promise<void> => {
    const result = await Effect.runPromise(Effect.either(store.get<Record<string, true>>(ARMED_STORE_KEY)));
    if (result._tag === "Left") {
      armingFault =
        `arming state unreadable (${result.left.message}) — armed regions were NOT resumed and arming ` +
        `changes will fail until the store file is repaired or removed; nothing was overwritten`;
      console.error(`[kernel] ${armingFault}`);
      return;
    }
    for (const key of Object.keys(result.right ?? {})) setArmed(key, true);
  };

  // The armed record as it would be persisted, computed WITHOUT mutating the
  // in-memory map — the transactional-arming precondition. armRegion writes
  // this to the store first and only calls setArmed after the write lands, so
  // a failed persist leaves memory and disk in sync (nothing changed) instead
  // of the old order (setArmed first, then persist) that diverged them on a
  // store write error.
  const armedRecordWith = (key: string, value: boolean): Record<string, true> => {
    const out: Record<string, true> = {};
    for (const [k, v] of getArmed()) if (v) out[k] = true;
    if (value) out[key] = true;
    else delete out[key];
    return out;
  };

  return KernelService.of({
    // Effect.sync, not Effect.succeed: the report reads docs.size at CALL
    // time, not at layer-build time (when it is always 0, before any
    // hydration) — a live count, not a frozen one.
    doctor: Effect.sync(() => ({
      id: "kernel",
      label: "Kernel",
      status: "ok" as const,
      detail: `${docs.size} canvas(es) hydrated`,
    })),

    start: () => {
      if (started) return;
      started = true;
      void (async () => {
        await hydrateArming();
        await hydrateAllDocs();
        void Effect.runPromise(snapshots.refresh(unionHints(docs)));

        canvases.subscribeChanges((name) => void resyncCanvas(name));
        snapshots.subscribe(() => scheduleCycle());

        setInterval(scheduleCycle, SAFETY_INTERVAL_MS);
        setInterval(() => {
          const length = getPulseLog().length;
          if (length !== lastPulseLogLength) emitSnapshot();
        }, PULSE_LOG_POLL_MS);

        scheduleCycle();
      })().catch((err) => console.error("[kernel] start() failed:", err));
    },

    getSnapshot: () => composeSnapshot(),

    armRegion: (canvasName, regionId, armedValue) =>
      Effect.gen(function* () {
        // Fail fast under a boot-time arming fault: the store could not be
        // read, so armed regions were NOT resumed and no write may proceed
        // (the corrupt file must not be clobbered). The caller surfaces this.
        if (armingFault !== undefined) {
          return { ok: false, error: armingFault } as const;
        }
        const key = armedStoreKey(canvasName, regionId);
        // Persist FIRST (memory untouched on failure), then mutate memory.
        const stored = yield* Effect.either(store.set(ARMED_STORE_KEY, armedRecordWith(key, armedValue)));
        if (stored._tag === "Left") {
          return {
            ok: false,
            error: `arming not saved (${stored.left.message}) — nothing changed; the region stays as it was`,
          } as const;
        }
        setArmed(key, armedValue);
        emitSnapshot();
        return { ok: true } as const;
      }),

    pulseRegion: (canvasName, regionId, opts) =>
      Effect.promise(() =>
        deliverPulse({
          canvasName,
          sourceNodeId: regionId,
          kind: "manual",
          regionId,
          summary: opts?.summary ?? "manual pulse",
          forceDry: opts?.dry,
        }),
      ).pipe(Effect.tap(() => Effect.sync(emitSnapshot))),

    subscribe: (listener) => {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },

    subscribeCanvasMutated: (listener) => {
      canvasMutatedListeners.add(listener);
      return () => canvasMutatedListeners.delete(listener);
    },
  });
};

// A layer factory (not a bare Layer) because the shared ChatService instance
// must be constructed once, ahead of time, and passed in — the same instance
// registerChatIpc wires up for user-driven turns, so a pulse-driven turn and
// a human reuse one live ACP session per agent (kernel-design.md §2.3).
export const KernelLive = (
  chatService: ChatService,
): Layer.Layer<KernelService, never, CanvasesService | SnapshotsService | StoreService> =>
  Layer.effect(
    KernelService,
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;
      const store = yield* StoreService;
      return makeKernelService(canvases, snapshots, store, chatService);
    }),
  );
