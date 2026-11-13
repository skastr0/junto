/**
 * Scene ops: the stores turned into the contract's SceneOp stream for the
 * engine (contract.ts, section 20). Plain observe/onChange — no React, no
 * card mounted. `retainSceneOps` emits `load` once the canvas's rows are
 * held, then exactly the ops a change earns: one per model row a `Changed`
 * names, one per seat whose live state moved, plus selection, theme and
 * wire pulses. Facts only — `paint/` turns them into records.
 */
import { observe } from "@legendapp/state";
import { asCanvasName } from "@shared/model";
import type { NodeOf } from "@shared/model";
import type { RingState } from "@shared/wire/rings";
import { ringState } from "@shared/wire/rings";
import { rankOf } from "@shared/wire/urgency";
import { seatLevel } from "@shared/wire/seat-level";
import type { AgentSignalKind } from "@shared/agent-signals";
import type { WireTrafficEvent } from "@shared/wire-traffic";
import type { CardFact, SceneOp, SeatLive, SelectionFact, WireFact } from "../contract";
import { agentSeat$, clueFromAgentSeat } from "../../lib/agent-seat-state";
import { seatSignalRollups$ } from "../../lib/agent-signals-state";
import { resolveActivityGlyph } from "../../lib/activity";
import { getJuntoApi } from "../../lib/junto-api";
import { seatMachineLine } from "../../lib/machines";
import { modelStore } from "../../lib/use-model";
import { regionUrgency$ } from "../../lib/region-urgency";
import { preambleByNodeId$ } from "../../lib/preamble-state";
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
import { blockedNodeIds, regionParentOf } from "./shared";
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
  a.tasks?.state === b.tasks?.state &&
  a.tasks?.label === b.tasks?.label &&
  a.tasks?.title === b.tasks?.title &&
  a.tasks?.more === b.tasks?.more &&
  a.preamble?.speaker === b.preamble?.speaker &&
  a.preamble?.now === b.preamble?.now &&
  a.preamble?.before === b.preamble?.before &&
  a.preamble?.hue === b.preamble?.hue &&
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
    default:
      return { kind: "plain" };
  }
};

/** The speaker word the bubble prints, "" for the agent's own voice. */
const BUBBLE_SPEAKER: Readonly<Record<PreambleProvenance, string>> = {
  agent: "",
  ai: "AI",
  system: "Junto",
  operator: "you",
};

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
): SeatLive => {
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
  const activity =
    seatEvent?.state === "attention" && seatEvent.reason ? { ...mark, label: seatEvent.reason } : mark;
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
  const line = saying.kind === "signal" ? `${saying.word} ${saying.text}` : saying.text;
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
  return {
    ring,
    line,
    mark: { tone: activity.tone, label: activity.label },
    urgency: rankOf(seatLevel({ activity, signal, failure })),
    running: facts.running === true,
    overseer: node.overseer,
    harness: node.harness,
    saying: sayingFact(saying),
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
            speaker: BUBBLE_SPEAKER[current.provenance],
            now: current.text,
            ...(bubble?.previous === undefined ? {} : { before: bubble.previous.text }),
            hue: current.tone,
            dx: 0,
          },
        }),
    portrait: {
      seed: id,
      expression,
      ...(portraitConfig === undefined ? {} : { config: portraitConfig }),
    },
    ...(spectrum === "empty" || spectrum === "gone" ? { occupancy: spectrum } : {}),
    ...(node.color === undefined ? {} : { nameColor: node.color }),
  };
};

const sameFact = (a: CardFact | undefined, b: CardFact): boolean =>
  a !== undefined &&
  a.row === b.row &&
  a.derived.regionId === b.derived.regionId &&
  a.derived.regionDepth === b.derived.regionDepth &&
  a.derived.blocked === b.derived.blocked &&
  a.derived.z === b.derived.z &&
  a.derived.regionUrgency?.kind === b.derived.regionUrgency?.kind &&
  a.derived.regionUrgency?.reach === b.derived.regionUrgency?.reach;

const sameWire = (a: WireFact | undefined, b: WireFact): boolean => a !== undefined && a.row === b.row;

const sameSelection = (a: SelectionFact, b: SelectionFact): boolean =>
  a.wireId === b.wireId &&
  a.connectionFocusNodeId === b.connectionFocusNodeId &&
  a.nodeIds.length === b.nodeIds.length &&
  a.nodeIds.every((id, i) => id === b.nodeIds[i]);

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
      const parentOf = regionParentOf(canvasName);
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
        cards.push({
          id,
          row,
          derived: {
            ...(regionId === undefined ? {} : { regionId }),
            regionDepth: regionDepthOf(parentOf, regionId),
            blocked: blocked.has(id),
            z: row.z,
            ...(held === undefined ? {} : { regionUrgency: { kind: held.urgency, reach: held.reach } }),
          },
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
        }
      }
      for (const id of agents) {
        if (seatOffs.has(id)) continue;
        const node$ = modelStore.canvas$(canvasName).nodes[id];
        const off = observe(() => {
          const node = node$.get();
          if (node === undefined || node.kind !== "agent") return;
          const live = seatLiveOf(canvasName, id, node, blockedNodeIds(canvasName), ringForms);
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
      const edgeId = state$.selectedEdgeId.get();
      const focus = state$.connectionFocusNodeId.get();
      const fact: SelectionFact = {
        nodeIds: [...state$.selectedNodeIds.get()],
        ...(edgeId === "" ? {} : { wireId: edgeId }),
        ...(focus === "" ? {} : { connectionFocusNodeId: focus }),
      };
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
    seatOffs.clear();
    seatLives.clear();
    ringForms.clear();
  };
};
