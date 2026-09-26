/**
 * What a seat's bubble is allowed to say.
 *
 * A preamble is premium space over the seat, so it tells only what the
 * operator would want to look up for: the agent's own words (and the rare
 * deliverable, see seatToolPreamble), which arrive from main already shaped;
 * signals raised and answered; a seat done, waiting on you, or dropping out
 * mid-work; the AI's reading turning notably bad or notably good; a peer's
 * mail landing, and mail that failed to land. Routine motion (picking up
 * work, reading mail, the operator's own prompt echoed back, sender-side
 * copies of mail) says nothing: the ring and the wire already show it.
 *
 * The mappers are pure and first-sight silent: hydrating a canvas, a
 * snapshot, or a restart never replays history as news.
 */

import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { AgentSignal, AgentSignalKind } from "@shared/agent-signals";
import type { CanvasNode } from "@shared/canvas";
import type { JuntoApi } from "@shared/ipc";
import {
  normalizePreambleText,
  type PreambleEvent,
  type PreambleTone,
} from "@shared/preamble";
import {
  THREAD_HEALTH_LABEL,
  THREAD_HEALTH_TONE,
  type ThreadHealthValue,
} from "@shared/thread-health";
import type { WireTrafficEvent } from "@shared/wire-traffic";
import { agentSeat$ } from "./agent-seat-state";
import { agentSignals$ } from "./agent-signals-state";
import { showPreamble } from "./preamble-state";
import { seatAwareness$ } from "./seat-awareness";
import { state$ } from "./state";

/** A change older than this is history (hydration, a restart), not news. */
export const PREAMBLE_FRESH_MS = 15_000;

const TTL = {
  signal: 14_000,
  health: 10_000,
  state: 9_000,
  mail: 8_000,
  failed: 12_000,
} as const;

let sequence = 0;
const nextId = (source: string): string => `${source}-${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;

const clip = (text: string, max = 90): string => {
  const flat = normalizePreambleText(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const note = (
  source: string,
  canvasName: string,
  nodeId: string,
  now: number,
  ttl: number,
  fields: Pick<PreambleEvent, "text" | "provenance" | "action" | "tone">,
): PreambleEvent => ({
  preambleId: nextId(source),
  canvasName,
  nodeId,
  expiresAt: now + ttl,
  ...fields,
  text: clip(fields.text),
});

// --- signals -------------------------------------------------------------------

const SIGNAL_WORD: Readonly<Record<AgentSignalKind, string>> = {
  blocked: "blocked",
  escalate: "wants you",
  feedback: "ready for review",
};

const SIGNAL_TONE: Readonly<Record<AgentSignalKind, PreambleTone>> = {
  blocked: "crimson",
  escalate: "amber",
  feedback: "cyan",
};

/** A signal raised, answered, dismissed or withdrawn, as its seat's note. */
export const signalPreamble = (
  prior: AgentSignal | undefined,
  next: AgentSignal,
  now: number,
): PreambleEvent | undefined => {
  const at = next.state === "open" ? next.createdAt : (next.closedAt ?? next.createdAt);
  if (now - at > PREAMBLE_FRESH_MS) return undefined;
  if (prior?.state === next.state) return undefined;
  const base = (fields: Pick<PreambleEvent, "text" | "provenance" | "action" | "tone">) =>
    note("signal", next.canvasName, next.nodeId, now, TTL.signal, fields);
  if (next.state === "open") {
    return base({
      text: `${SIGNAL_WORD[next.kind]}: ${next.text}`,
      provenance: "agent",
      action: "signal",
      tone: SIGNAL_TONE[next.kind],
    });
  }
  if (prior === undefined) return undefined;
  if (next.state === "answered") {
    return base({
      text: `answered: ${next.response?.text ?? next.text}`,
      provenance: "operator",
      action: "signal-clear",
      tone: "green",
    });
  }
  if (next.state === "dismissed") {
    return base({ text: `dismissed: ${next.text}`, provenance: "operator", action: "signal-clear", tone: "steel" });
  }
  return base({ text: `cleared: ${next.text}`, provenance: "agent", action: "signal-clear", tone: "green" });
};

// --- thread health -------------------------------------------------------------

/** Readings worth a note: trouble setting in, and work going notably well. */
const HEALTH_GREAT: ReadonlySet<ThreadHealthValue> = new Set(["succeeding", "exceeding"]);

/**
 * The AI's reading when it turns notably bad or notably good; drift within
 * a band (stuck to looping, steady to going well) and recovery to ordinary
 * are silent. Waiting on the operator is told by the seat's own state.
 */
export const healthPreamble = (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly prior: ThreadHealthValue | undefined;
  readonly value: ThreadHealthValue;
  readonly observedAt: number;
  readonly now: number;
}): PreambleEvent | undefined => {
  if (input.prior === undefined || input.prior === input.value) return undefined;
  if (input.now - input.observedAt > PREAMBLE_FRESH_MS * 4) return undefined;
  const trouble = THREAD_HEALTH_TONE[input.value] === "trouble";
  const great = HEALTH_GREAT.has(input.value);
  if (trouble && THREAD_HEALTH_TONE[input.prior] === "trouble") return undefined;
  if (great && HEALTH_GREAT.has(input.prior)) return undefined;
  if (!trouble && !great) return undefined;
  return note("health", input.canvasName, input.nodeId, input.now, TTL.health, {
    text: THREAD_HEALTH_LABEL[input.value],
    provenance: "ai",
    action: "health",
    tone: trouble ? "amber" : "green",
  });
};

// --- control state ---------------------------------------------------------------

export type SeatMoment = {
  readonly state: AgentSeatStateEvent["state"];
  readonly reason?: string;
  readonly needsLook: boolean;
};

/**
 * Control-state transitions worth telling: waiting on you, done, and a seat
 * dropping out while it was working. Starting up and picking up work are
 * the ring's to show.
 */
export const seatStatePreamble = (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly prior: SeatMoment | undefined;
  readonly next: SeatMoment;
  readonly now: number;
}): PreambleEvent | undefined => {
  const { prior, next } = input;
  if (prior === undefined) return undefined;
  const say = (text: string, tone: PreambleTone) =>
    note("state", input.canvasName, input.nodeId, input.now, TTL.state, {
      text,
      provenance: "system",
      action: "state",
      tone,
    });
  if (next.state === "attention" && prior.state !== "attention") {
    return /stall/i.test(next.reason ?? "") ? say("stalled, needs a look", "amber") : say("waiting on you", "amber");
  }
  if (next.state === "idle" && next.needsLook && !(prior.state === "idle" && prior.needsLook)) {
    // "Ready for review" is the feedback signal's word; the seat line keeps
    // "done, not read yet" until the operator looks.
    return say("done", "green");
  }
  if (next.state === "gone" && (prior.state === "working" || prior.state === "attention")) {
    return say("dropped out mid-work", "amber");
  }
  return undefined;
};

// --- mail --------------------------------------------------------------------------

/**
 * One message across a wire, told on the receiving seat only when it is a
 * peer's: the operator's own prompts and answers, and Junto's notices, echo
 * what the operator already knows (an answer is told by its signal). A
 * message that failed to land is told whoever sent it.
 */
export const wirePreambles = (
  event: WireTrafficEvent,
  titleOf: (nodeId: string) => string | undefined,
  now: number,
): ReadonlyArray<PreambleEvent> => {
  const preview = event.preview ? `: ${event.preview}` : "";
  if (event.failed === true) {
    const from = event.fromNodeId === undefined ? "mail" : `mail from ${event.fromName ?? titleOf(event.fromNodeId) ?? "a peer"}`;
    return [
      note("mail", event.canvasName, event.toNodeId, now, TTL.failed, {
        text: `${from} did not land, retrying${preview}`,
        provenance: "system",
        action: "mail-failed",
        tone: "crimson",
      }),
    ];
  }
  if (event.fromNodeId === undefined || event.kind === "answer") return [];
  const who = event.fromName ?? titleOf(event.fromNodeId) ?? "a peer";
  return [
    note("mail", event.canvasName, event.toNodeId, now, TTL.mail, {
      text: `${event.kind === "prompt" ? "asked by" : "mail from"} ${who}${preview}`,
      provenance: "agent",
      action: "mail-in",
      tone: "violet",
    }),
  ];
};

// --- wiring --------------------------------------------------------------------------

const titleOf = (nodeId: string): string | undefined => {
  const node = state$.doc.peek().nodes.find((n) => n.id === nodeId);
  if (node === undefined) return undefined;
  const first = node.type === "text" ? node.text.split("\n")[0]?.trim() : undefined;
  return first || undefined;
};

const bindingOf = (node: CanvasNode): string | undefined => {
  const bound = node.ether?.terminal?.bindingId;
  return typeof bound === "string" ? bound : agentSeat$.bindingIdByNodeId[node.id].peek();
};

/** bindingId → nodeId for the open canvas, rebuilt per call (events are sparse). */
const nodeByBinding = (): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const node of state$.doc.peek().nodes) {
    const binding = bindingOf(node);
    if (binding !== undefined) out.set(binding, node.id);
  }
  return out;
};

/**
 * Subscribe every renderer-side source. Main's own preambles (the agent's
 * words and its tool calls) keep arriving through `onPreamble` in App.
 */
export const startPreambleSources = (api: Pick<JuntoApi, "onWireTraffic">): (() => void) => {
  const offs: Array<() => void> = [];

  // Signals: diff by id; the canvas-scoped mirror is hydrated silently.
  let signals = new Map<string, AgentSignal>(Object.entries(agentSignals$.peek()));
  offs.push(
    agentSignals$.onChange(() => {
      const now = Date.now();
      const next = new Map<string, AgentSignal>(Object.entries(agentSignals$.peek()));
      for (const [id, signal] of next) {
        const prior = signals.get(id);
        if (prior === signal) continue;
        const told = signalPreamble(prior, signal, now);
        if (told) showPreamble(told);
      }
      signals = next;
    }),
  );

  // Thread health: the reading's value per binding, first sight silent.
  const health = new Map<string, ThreadHealthValue>();
  const readHealth = (announce: boolean): void => {
    const now = Date.now();
    const canvasName = state$.canvasName.peek();
    const nodes = nodeByBinding();
    for (const [bindingId, assessment] of Object.entries(seatAwareness$.byBindingId.peek())) {
      const reading = assessment?.health;
      if (reading === undefined) continue;
      const prior = health.get(bindingId);
      health.set(bindingId, reading.value);
      const nodeId = nodes.get(bindingId);
      if (!announce || nodeId === undefined || prior === undefined) continue;
      const told = healthPreamble({ canvasName, nodeId, prior, value: reading.value, observedAt: reading.observedAt, now });
      if (told) showPreamble(told);
    }
  };
  readHealth(false);
  offs.push(seatAwareness$.rev.onChange(() => readHealth(true)));

  // Control state: transitions per binding, first sight silent.
  const moments = new Map<string, SeatMoment>();
  const readSeats = (announce: boolean): void => {
    const now = Date.now();
    const canvasName = state$.canvasName.peek();
    const nodes = nodeByBinding();
    const needsLook = agentSeat$.needsLookByBindingId.peek();
    for (const [bindingId, event] of Object.entries(agentSeat$.byBindingId.peek())) {
      if (event === undefined) continue;
      const next: SeatMoment = { state: event.state, reason: event.reason, needsLook: needsLook[bindingId] === true };
      const prior = moments.get(bindingId);
      moments.set(bindingId, next);
      const nodeId = nodes.get(bindingId);
      if (!announce || nodeId === undefined) continue;
      const told = seatStatePreamble({ canvasName, nodeId, prior, next, now });
      if (told) showPreamble(told);
    }
  };
  readSeats(false);
  offs.push(agentSeat$.rev.onChange(() => readSeats(true)));

  // Mail: one source, wire traffic at delivery.
  const offWire = api.onWireTraffic?.((event) => {
    if (event.canvasName !== state$.canvasName.peek()) return;
    for (const told of wirePreambles(event, titleOf, Date.now())) showPreamble(told);
  });
  if (offWire) offs.push(offWire);

  return () => {
    for (const off of offs) off();
  };
};
