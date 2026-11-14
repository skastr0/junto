/**
 * Scene ops: the stores turned into the contract's SceneOp stream for the
 * engine (contract.ts, section 20). Plain observe/onChange — no React, no
 * card mounted. `retainSceneOps` emits `load` once the canvas's rows are
 * held, then exactly the ops a change earns: one per model row a `Changed`
 * names, one per seat whose live state moved, plus selection, theme and
 * wire pulses. Facts only — `paint/` turns them into records.
 */
import { observable, observe } from "@legendapp/state";
import { asCanvasName } from "@shared/model";
import type { NodeOf } from "@shared/model";
import type { RingState } from "@shared/wire/rings";
import { ringState } from "@shared/wire/rings";
import { rankOf } from "@shared/wire/urgency";
import { seatLevel } from "@shared/wire/seat-level";
import type { AgentSignalKind } from "@shared/agent-signals";
import { nextCacheStatusChange, seatCacheStatusLine, SEAT_FRESH_NEXT_LINE } from "@shared/seat-next-launch";
import type { WireTrafficEvent } from "@shared/wire-traffic";
import type { CardFact, SceneOp, SeatLive, SelectionFact, WireFact } from "../contract";
import { agentSeat$, clueFromAgentSeat } from "../../lib/agent-seat-state";
import { seatSignalRollups$ } from "../../lib/agent-signals-state";
import { resolveActivityGlyph } from "../../lib/activity";
import { getJuntoApi } from "../../lib/junto-api";
import { machineLabelIn, seatMachineLine } from "../../lib/machines";
import { modelStore } from "../../lib/use-model";
import { regionUrgency$ } from "../../lib/region-urgency";
import { preambleByNodeId$ } from "../../lib/preamble-state";
import {
  askSeatNextTurn,
  forgetSeatNextTurn,
  nextMoment,
  seatCacheWindow$,
  seatLaunchMovedKey,
  seatNextTurn$,
  seatStillForNextTurn,
} from "../../lib/seat-next-launch";
import { offboardFailureLine, seatOffboard$ } from "../../lib/seat-offboard-state";
import { cardMark, seatFactsForNode } from "../../lib/seat-projections";
import { seatSaying, type SeatSaying } from "../../lib/seat-line";
import { seatTasks$ } from "../../lib/seat-tasks";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { themeMode$ } from "../../lib/theme-mode";
import { threadHealthMarkOf } from "../../lib/thread-health";
import { pickPulseEdge, type PulseEdge } from "../../lib/wire-pulse";
import { portraitOverrides$ } from "../../lib/portrait-overrides-state";
import { seatPortraitMood } from "../../lib/portrait-mood";
import { canvasSelectionFact } from "../../lib/canvas-focus";
import { blockedNodeIds } from "./shared";
import { cardLive$, sameCardLive } from "./kinds";
import { cardLayout } from "./layout";
import { deriveOccupancy } from "@shared/occupancy";
import { portraitExpression } from "@shared/portrait-expression";
import { portraitCharacter, type PortraitConfig } from "@shared/agent-portrait";
import type { PreambleProvenance } from "@shared/preamble";
import type { RingForm } from "@shared/wire/rings";

/** How deep a region sits: its own parent chain's length, 0 for none. */
const regionDepthOf = (parentOf: ReadonlyMap<string, string>, regionId: string | undefined): number => {
  if (regionId === undefined) return 0;
  let depth = 0;
  const seen = new Set<string>([regionId]);
  for (let up = parentOf.get(regionId); up !== undefined && !seen.has(up); up = parentOf.get(up)) {
    seen.add(up);
    depth += 1;
  }
  return depth;
};

const sameRing = (a: RingState, b: RingState): boolean =>
  a.ring === b.ring &&
  a.hue === b.hue &&
  a.stale === b.stale &&
  a.flag === b.flag &&
  JSON.stringify(a.glow) === JSON.stringify(b.glow) &&
  JSON.stringify(a.halo) === JSON.stringify(b.halo);

const sameLive = (a: SeatLive | undefined, b: SeatLive): boolean =>
  a !== undefined &&
  sameRing(a.ring, b.ring) &&
  a.line === b.line &&
  a.mark.tone === b.mark.tone &&
  a.mark.label === b.mark.label &&
  a.urgency === b.urgency &&
  a.running === b.running &&
  a.overseer === b.overseer &&
  a.harness === b.harness &&
  a.ringSince === b.ringSince &&
  a.nameColor === b.nameColor &&
  a.occupancy === b.occupancy &&
  a.saying?.kind === b.saying?.kind &&
  a.saying?.lead === b.saying?.lead &&
  a.saying?.tone === b.saying?.tone &&
  a.saying?.stale === b.saying?.stale &&
  a.saying?.expired === b.saying?.expired &&
  a.tasks?.state === b.tasks?.state &&
  a.tasks?.label === b.tasks?.label &&
  a.tasks?.title === b.tasks?.title &&
  a.tasks?.more === b.tasks?.more &&
  a.preamble?.speaker === b.preamble?.speaker &&
  a.preamble?.now === b.preamble?.now &&
  a.preamble?.before === b.preamble?.before &&
  a.preamble?.hue === b.preamble?.hue &&
  a.preamble?.strong === b.preamble?.strong &&
  a.preamble?.glyph === b.preamble?.glyph &&
  a.preamble?.since === b.preamble?.since &&
  a.preamble?.dx === b.preamble?.dx &&
  a.portrait?.seed === b.portrait?.seed &&
  a.portrait?.expression === b.portrait?.expression &&
  JSON.stringify(a.portrait?.config) === JSON.stringify(b.portrait?.config);

/** seatSaying's kinds as the contract names them, with its drawn parts. */
const sayingFact = (saying: SeatSaying): NonNullable<SeatLive["saying"]> => {
  switch (saying.kind) {
    case "signal":
      return { kind: "signal", lead: saying.word, tone: saying.tone };
    case "failure":
      return { kind: "failure" };
    case "reading":
      return { kind: "reading", stale: saying.stale };
    case "state":
      return saying.tone === undefined ? { kind: "plain" } : { kind: "plain", tone: saying.tone };
    default:
      return { kind: "plain" };
  }
};

/**
 * Bumped by a seat's scheduled re-ask or cache-line tick so its observer
 * re-derives even when main's answer is unchanged. Read only inside the
 * cache-line branch, so only a seat showing that line follows it.
 */
const seatLineTick$ = observable<Record<string, number>>({});

/** What the seat's next-turn ask owes: the card's effect deps as one key, and the moments still ahead. */
type SeatLaunchProbe = {
  readonly still: boolean;
  readonly key: string;
  readonly askAt: number | undefined;
  readonly lineAt: number | undefined;
};

type SeatLiveOf = { readonly live: SeatLive; readonly launch: SeatLaunchProbe };

/** The speaker word the bubble prints; the agent's own voice carries none. */
const BUBBLE_SPEAKER: Readonly<Record<PreambleProvenance, string | undefined>> = {
  agent: undefined,
  ai: "AI",
  system: "Junto",
  operator: "you",
};

/** The action's glyph, named as the view's icon is (PreambleBubbleView's KIND). */
const BUBBLE_GLYPH: Readonly<Record<string, string | undefined>> = {
  say: undefined,
  tool: "package-check",
  signal: "flag",
  "signal-clear": "circle-check",
  health: "activity",
  "mail-in": "mail",
  "mail-out": "send",
  "mail-failed": "mail-warning",
  "mail-held": "mail-warning",
  state: "circle-dot",
};

/** A firmer frame for a signal or failed mail (contract's `strong`). */
const BUBBLE_STRONG = new Set(["signal", "mail-failed"]);

/** The offboard failure the card falls back to, read tracked (the `Of` readers peek). */
const offboardFailure = (canvasName: string, seatId: string): string | undefined =>
  offboardFailureLine(seatOffboard$.byKey[`${canvasName}\u0000${seatId}`].get());

/**
 * One seat's live state from the stores its card reads: the ring's inputs,
 * the line's words, the urgency rank, the task counts and the bubble. Every
 * read is tracked by the caller's `observe`, so a seat report re-derives the
 * seats whose own inputs moved; the globals re-derive them all, as today.
 */
const seatLiveOf = (
  canvasName: string,
  id: string,
  node: NodeOf<"agent">,
  blocked: ReadonlySet<string>,
  ringForms: Map<string, { form: RingForm; since: number }>,
): SeatLiveOf => {
  const bindingId = node.bindingId;
  const rollup = seatSignalRollups$.get()[id];
  const signal: AgentSignalKind | undefined = rollup?.kind;
  const seatEvent = agentSeat$.byBindingId[bindingId].get();
  const needsLook = agentSeat$.needsLookByBindingId[bindingId].get() === true;
  const session = terminal$.sessionByBindingId[bindingId].get();
  const facts = seatFactsForNode({
    nodeId: id,
    seatEvent,
    session,
    needsLook,
    graphBlocked: blocked.has(id),
    managedSeat: true,
  });
  const mark = cardMark(facts);
  // The card's next-turn answer, read tracked: a still seat whose next turn
  // starts fresh says so, and one that picks up where it was reads against
  // its cache window. The feed asks main for both (below, `launch`).
  const still = seatStillForNextTurn({ facts, mark, hand: signal, seatState: seatEvent?.state });
  const nextTurn = seatNextTurn$[canvasName][id].get();
  const cacheWindow = seatCacheWindow$[canvasName][id].get();
  const freshNext = still && nextTurn?.fresh === true;
  const base =
    seatEvent?.state === "attention" && seatEvent.reason ? { ...mark, label: seatEvent.reason } : mark;
  const activity = freshNext ? { ...base, label: SEAT_FRESH_NEXT_LINE } : base;
  const health = threadHealthMarkOf(bindingId, signal);
  const ring = ringState({
    glyph: resolveActivityGlyph(activity.mode, activity.tone, activity.glyph),
    tone: activity.tone,
    health: health.health,
    healthValue: health.value,
    healthStale: health.healthStale,
    signal,
  });
  // The form's clock: `done` lands once, timed from the change.
  const heldForm = ringForms.get(id);
  const ringSince = heldForm !== undefined && heldForm.form === ring.ring ? heldForm.since : Date.now();
  ringForms.set(id, { form: ring.ring, since: ringSince });
  // The failure chain the card shows: the machine's line, the exit message,
  // then a failed offboard.
  const exitMessage =
    session?.exitReason !== undefined && session?.exitReason !== null && session.exitMessage
      ? session.exitMessage
      : undefined;
  const failure =
    seatMachineLine({
      host: node.host,
      harness: node.harness,
      thisName: state$.settings.machine.name.get(),
      machines: state$.machines.get(),
      facts: state$.machineFacts.get(),
    })?.line ??
    exitMessage ??
    offboardFailure(canvasName, id);
  const held = seatTasks$.bySeat[id].get();
  const bubble = preambleByNodeId$[id].get();
  const saying = seatSaying({
    activity,
    signal: rollup?.signal,
    failure,
    health: { health: health.health, healthStale: health.healthStale, line: health.line },
  });
  // The card's cache line: a still seat that picks up where it was reads its
  // state words against the window, never beside "fresh next". Only a plain
  // state line takes it — a signal, failure or reading speaks instead.
  const cacheWindowFace = cacheWindow !== undefined && !freshNext ? cacheWindow : undefined;
  let line = saying.kind === "signal" ? `${saying.word} ${saying.text}` : saying.text;
  let sayingOut = sayingFact(saying);
  let lineAt: number | undefined;
  if (saying.kind === "state" && saying.tone === undefined && cacheWindowFace !== undefined) {
    // The words change on the minute and at the window's end; the tick below
    // re-derives this seat at each, as the card's own timer does.
    seatLineTick$[`${canvasName}\u0000${id}`].get();
    const status = seatCacheStatusLine(saying.text, cacheWindowFace, Date.now());
    line = status.expired ? `${status.line},` : status.line;
    sayingOut = { kind: "cache", ...(status.expired ? { expired: true } : {}) };
    lineAt = nextCacheStatusChange(cacheWindowFace, Date.now());
  }
  const clue = clueFromAgentSeat(seatEvent, needsLook);
  const spectrum = deriveOccupancy({
    hasOccupant: clue?.hasOccupant ?? false,
    activity: clue?.activity,
    needs: clue?.needs,
    lastSeenAtMs: clue?.lastSeenAtMs,
    nowMs: Date.now(),
  });
  const portraitConfig = portraitOverrides$[id].get() as PortraitConfig | undefined;
  const expression = portraitExpression({
    ...seatPortraitMood(activity, { value: health.value, healthStale: health.healthStale }, signal),
    temperament: portraitCharacter(id, portraitConfig).temperament,
  });
  const current = bubble?.current;
  // The ask's inputs, all read tracked: the card's moved key plus the offboard
  // step and the cache windows this machine's seats are cut at.
  const reachable =
    node.host === undefined ? undefined : state$.machineFacts[node.host].reachable.get();
  const viewed = terminal$.openByNodeId[id].get() !== undefined;
  const offboardAt = seatOffboard$.byKey[`${canvasName}\u0000${id}`].get()?.at;
  const windows = JSON.stringify(state$.settings.offboard.get() ?? null);
  const launch: SeatLaunchProbe = {
    still,
    key: `${seatLaunchMovedKey({
      bindingId,
      seatState: seatEvent?.state,
      seatAt: seatEvent?.at,
      epoch: session?.epoch,
      status: session?.status,
      reachable,
      viewed,
    })}${offboardAt ?? ""}${windows}`,
    askAt: still ? nextMoment(nextTurn?.freshAt, cacheWindow?.windowEndsAt, Date.now()) : undefined,
    lineAt,
  };
  return {
    live: {
      ring,
      line,
      mark: { tone: activity.tone, label: activity.label },
      urgency: rankOf(seatLevel({ activity, signal, failure })),
      running: facts.running === true,
      overseer: node.overseer,
      harness: node.harness,
      saying: sayingOut,
      ringSince,
      ...(held === undefined
        ? {}
        : {
            tasks: {
              state: held.state,
              label: held.label,
              title: held.title,
              more: Math.max(0, held.tasks.length - 1),
            },
          }),
      ...(current === undefined
        ? {}
        : {
            preamble: {
              ...(BUBBLE_SPEAKER[current.provenance] === undefined
                ? {}
                : { speaker: BUBBLE_SPEAKER[current.provenance] }),
              now: current.text,
              ...(bubble?.previous === undefined ? {} : { before: bubble.previous.text }),
              hue: current.tone,
              ...(BUBBLE_STRONG.has(current.action) ? { strong: true } : {}),
              dx: 0,
              ...(BUBBLE_GLYPH[current.action] === undefined ? {} : { glyph: BUBBLE_GLYPH[current.action] }),
              since: current.shownAt,
            },
          }),
      portrait: {
        seed: id,
        expression,
        ...(portraitConfig === undefined ? {} : { config: portraitConfig }),
      },
      ...(spectrum === "empty" || spectrum === "gone" ? { occupancy: spectrum } : {}),
      ...(node.color === undefined ? {} : { nameColor: node.color }),
    },
    launch,
  };
};

const sameFact = (a: CardFact | undefined, b: CardFact): boolean =>
  a !== undefined &&
  a.row === b.row &&
  a.derived.regionId === b.derived.regionId &&
  a.derived.regionDepth === b.derived.regionDepth &&
  a.derived.blocked === b.derived.blocked &&
  a.derived.z === b.derived.z &&
  a.derived.ringCap === b.derived.ringCap &&
  a.derived.remote?.machine === b.derived.remote?.machine &&
  JSON.stringify(a.derived.nameSlot) === JSON.stringify(b.derived.nameSlot) &&
  a.derived.regionUrgency?.kind === b.derived.regionUrgency?.kind &&
  a.derived.regionUrgency?.reach === b.derived.regionUrgency?.reach &&
  sameCardLive(a, b);

const sameWire = (a: WireFact | undefined, b: WireFact): boolean => a !== undefined && a.row === b.row;

const sameIdSet = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
};

const sameSelection = (a: SelectionFact, b: SelectionFact): boolean =>
  a.wireId === b.wireId &&
  a.connectionFocusNodeId === b.connectionFocusNodeId &&
  a.focusedNodeId === b.focusedNodeId &&
  a.nodeIds.length === b.nodeIds.length &&
  a.nodeIds.every((id, i) => id === b.nodeIds[i]) &&
  (a.focusMode === undefined) === (b.focusMode === undefined) &&
  (a.focusMode === undefined ||
    (a.focusMode.kind === b.focusMode!.kind &&
      a.focusMode.rootId === b.focusMode!.rootId &&
      sameIdSet(a.focusMode.memberIds, b.focusMode!.memberIds) &&
      sameIdSet(a.focusMode.leadIds, b.focusMode!.leadIds) &&
      sameIdSet(a.focusMode.wireIds, b.focusMode!.wireIds)));

/**
 * The ops stream for one open canvas. `emit` is called synchronously, once
 * per observer pass, with the ops that pass earned — never empty.
 */
export const retainSceneOps = (
  canvasName: string,
  emit: (ops: ReadonlyArray<SceneOp>) => void,
): (() => void) => {
  if (canvasName === "") return () => undefined;
  const stops: Array<() => void> = [];

  // --- model rows → load / card / removeCard / wire / removeWire -----------
  let loaded = false;
  let previousCards = new Map<string, CardFact>();
  let previousWires = new Map<string, WireFact>();

  stops.push(
    observe(() => {
      const model = modelStore.canvas$(canvasName);
      const nodeIds = model.nodeIds.get();
      const wireIds = model.wireIds.get();
      const layout = cardLayout(canvasName);
      const parentOf = layout.parentOf;
      const liveFacts = cardLive$(canvasName);
      const machines = state$.machines.get();
      const blocked = blockedNodeIds(canvasName);
      const regionUrgency = regionUrgency$.get();

      const cards: CardFact[] = [];
      const cardIds = new Set<string>();
      nodeIds.forEach((id) => {
        cardIds.add(id);
        const row = model.nodes[id].get();
        if (row === undefined) return;
        const regionId = parentOf.get(id);
        const held = row.kind === "region" ? regionUrgency[id] : undefined;
        const ringCap = layout.ringCaps.get(id);
        const nameSlot = row.kind === "region" ? layout.nameSlots.get(id) : undefined;
        const remote =
          row.kind === "peer" || row.kind === "stub"
            ? row.host === undefined
              ? undefined
              : { machine: machineLabelIn(machines, row.host) }
            : undefined;
        const live = liveFacts[id].get();
        cards.push({
          id,
          row,
          derived: {
            ...(regionId === undefined ? {} : { regionId }),
            regionDepth: regionDepthOf(parentOf, regionId),
            blocked: blocked.has(id),
            z: row.z,
            ...(ringCap === undefined ? {} : { ringCap }),
            ...(nameSlot === undefined ? {} : { nameSlot }),
            ...(held === undefined ? {} : { regionUrgency: { kind: held.urgency, reach: held.reach } }),
            ...(remote === undefined ? {} : { remote }),
          },
          ...(live?.kind === undefined ? {} : { kind: live.kind }),
          ...(live?.spine === undefined ? {} : { spine: live.spine }),
        });
      });
      const wires: WireFact[] = [];
      for (const id of wireIds) {
        const row = model.wires[id].get();
        if (row !== undefined) wires.push({ id, row });
      }

      if (!loaded) {
        loaded = true;
        previousCards = new Map(cards.map((fact) => [fact.id, fact]));
        previousWires = new Map(wires.map((fact) => [fact.id, fact]));
        emit([{ kind: "load", canvas: asCanvasName(canvasName), cards, wires }]);
        return;
      }

      const ops: SceneOp[] = [];
      for (const fact of cards) {
        const was = previousCards.get(fact.id);
        if (was === undefined || !sameFact(was, fact)) ops.push({ kind: "card", fact });
      }
      for (const id of previousCards.keys()) {
        if (!cardIds.has(id)) ops.push({ kind: "removeCard", id });
      }
      const wireIdsNow = new Set(wires.map((fact) => fact.id));
      for (const fact of wires) {
        const was = previousWires.get(fact.id);
        if (was === undefined || !sameWire(was, fact)) ops.push({ kind: "wire", fact });
      }
      for (const id of previousWires.keys()) {
        if (!wireIdsNow.has(id)) ops.push({ kind: "removeWire", id });
      }
      previousCards = new Map(cards.map((fact) => [fact.id, fact]));
      previousWires = new Map(wires.map((fact) => [fact.id, fact]));
      if (ops.length > 0) emit(ops);
    }),
  );

  // --- seats → seat ops -----------------------------------------------------
  // One observer per agent node, so a seat report re-derives that seat and
  // the globals, never the whole board's live state.
  const seatOffs = new Map<string, () => void>();
  const seatLives = new Map<string, SeatLive>();
  const ringForms = new Map<string, { form: RingForm; since: number }>();
  // The next-turn ask each still seat owes main, with its scheduled moments.
  // The card's useSeatFreshNext does this per mounted card; the feed does it
  // per seat so the line is fed with no card on the canvas.
  const launchAsks = new Map<
    string,
    { key: string; askAt: number | undefined; lineAt: number | undefined; timer: ReturnType<typeof setTimeout> | undefined }
  >();
  const MAX_ASK_DELAY_MS = 2_147_483_647;
  const tickKey = (seatId: string): string => `${canvasName}\u0000${seatId}`;
  const armLaunchAsk = (seatId: string, at: number | undefined): ReturnType<typeof setTimeout> | undefined => {
    if (at === undefined) return undefined;
    return setTimeout(() => {
      const rec = launchAsks.get(seatId);
      if (rec === undefined) return;
      rec.timer = undefined;
      const now = Date.now();
      // The scheduled moment passed: a cold session or a window's end may have
      // moved the answer; the cache line's minute count moves regardless.
      if (rec.askAt !== undefined && now >= rec.askAt - 1_000) void askSeatNextTurn(canvasName, seatId);
      seatLineTick$[tickKey(seatId)].set(now);
    }, Math.min(Math.max(at - Date.now(), 0) + 1_000, MAX_ASK_DELAY_MS));
  };
  const syncLaunchAsk = (seatId: string, probe: SeatLaunchProbe): void => {
    const prior = launchAsks.get(seatId);
    if (!probe.still) {
      // A turn makes the last answer stale: drop it, so the line never flashes it.
      if (prior !== undefined) {
        if (prior.timer !== undefined) clearTimeout(prior.timer);
        launchAsks.delete(seatId);
        forgetSeatNextTurn(canvasName, seatId);
      }
      return;
    }
    const fireAt =
      probe.askAt !== undefined && probe.lineAt !== undefined
        ? Math.min(probe.askAt, probe.lineAt)
        : (probe.askAt ?? probe.lineAt);
    if (prior === undefined || prior.key !== probe.key) {
      if (prior?.timer !== undefined) clearTimeout(prior.timer);
      void askSeatNextTurn(canvasName, seatId);
      launchAsks.set(seatId, { key: probe.key, askAt: probe.askAt, lineAt: probe.lineAt, timer: armLaunchAsk(seatId, fireAt) });
      return;
    }
    if (prior.askAt !== probe.askAt || prior.lineAt !== probe.lineAt) {
      if (prior.timer !== undefined) clearTimeout(prior.timer);
      prior.askAt = probe.askAt;
      prior.lineAt = probe.lineAt;
      prior.timer = armLaunchAsk(seatId, fireAt);
    }
  };
  stops.push(
    observe(() => {
      const agents = new Set<string>();
      for (const id of modelStore.canvas$(canvasName).nodeIds.get()) {
        if (modelStore.canvas$(canvasName).nodes[id]?.kind.peek() === "agent") agents.add(id);
      }
      for (const [id, off] of [...seatOffs]) {
        if (!agents.has(id)) {
          off();
          seatOffs.delete(id);
          seatLives.delete(id);
          ringForms.delete(id);
          const ask = launchAsks.get(id);
          if (ask !== undefined) {
            if (ask.timer !== undefined) clearTimeout(ask.timer);
            launchAsks.delete(id);
          }
          seatLineTick$[tickKey(id)].delete();
        }
      }
      for (const id of agents) {
        if (seatOffs.has(id)) continue;
        const node$ = modelStore.canvas$(canvasName).nodes[id];
        const off = observe(() => {
          const node = node$.get();
          if (node === undefined || node.kind !== "agent") return;
          const { live, launch } = seatLiveOf(canvasName, id, node, blockedNodeIds(canvasName), ringForms);
          syncLaunchAsk(id, launch);
          const was = seatLives.get(id);
          seatLives.set(id, live);
          if (!sameLive(was, live)) emit([{ kind: "seat", id, live }]);
        });
        seatOffs.set(id, off);
      }
    }),
  );

  // --- selection → selection op ---------------------------------------------
  let previousSelection: SelectionFact | undefined;
  stops.push(
    observe(() => {
      const fact = canvasSelectionFact(canvasName);
      if (previousSelection === undefined || !sameSelection(previousSelection, fact)) {
        previousSelection = fact;
        emit([{ kind: "selection", fact }]);
      }
    }),
  );

  // --- theme → theme op -------------------------------------------------------
  stops.push(
    observe(() => {
      emit([{ kind: "theme", mode: themeMode$.get() }]);
    }),
  );

  // --- wire traffic → pulse ops ----------------------------------------------
  const offTraffic = getJuntoApi()?.onWireTraffic?.((event: WireTrafficEvent) => {
    if (event.canvasName !== canvasName || event.failed === true || event.held !== undefined) return;
    const edges: PulseEdge[] = [...modelStore.canvasOf(canvasName).wires.values()].map((wire) => ({
      id: wire.id,
      source: wire.from,
      target: wire.to,
      data: { verb: wire.verb },
    }));
    const target = pickPulseEdge(edges, event);
    if (target === undefined) return;
    emit([{ kind: "pulse", wireId: target.edgeId, at: event.at, pulse: event.kind, reverse: target.reverse }]);
  });
  if (offTraffic !== undefined) stops.push(offTraffic);

  return () => {
    for (const stop of stops.reverse()) stop();
    for (const off of seatOffs.values()) off();
    for (const id of seatOffs.keys()) seatLineTick$[`${canvasName}\u0000${id}`].delete();
    seatOffs.clear();
    seatLives.clear();
    ringForms.clear();
    for (const ask of launchAsks.values()) {
      if (ask.timer !== undefined) clearTimeout(ask.timer);
    }
    launchAsks.clear();
  };
};
