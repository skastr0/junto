/**
 * `junto companion-stdio --demo`: the full protocol against a built-in,
 * deterministic canvas, for the phone team to develop against without a Mac.
 *
 * Three regions, eight seats, every feed kind (blocked, attention, escalate,
 * feedback, health) and a mail history. It never touches the app or ~/.ssh.
 * Writes succeed and change the demo for this process only. The clock is
 * fixed and advances one second per write, so a transcript is reproducible.
 *
 * The feed and seats go through the same projections the app uses
 * (`buildOperatorFeed`, `companionSeat`), so the demo cannot drift from the
 * shapes a real Mac sends.
 */

import type { CanvasDoc, CanvasNode } from "./canvas";
import type { AgentSignal } from "./agent-signals";
import { rollupSeatSignals } from "./agent-signals";
import {
  handleCompanionRequest,
  makeWriteLimiter,
  outcomeFail,
  outcomeOk,
  type CompanionBackend,
} from "./companion-core";
import { companionPortraitSvg } from "./companion-portrait";
import type { CompanionChange, CompanionHost } from "./companion-session";
import { companionSeat } from "./companion-seats";
import {
  COMPANION_PROTOCOL,
  type CompanionMail,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
} from "./companion-protocol";
import { buildOperatorFeed, feedSeatsFromDoc, type FeedHealth } from "./operator-feed";
import { THREAD_HEALTH_LABEL, THREAD_HEALTH_TONE, type ThreadHealthReading, type ThreadHealthValue } from "./thread-health";
import type { AgentSeatState } from "./agent-seat-state";

export const DEMO_CANVAS = "demo";
export const DEMO_DEVICE_ID = "dev_00000000000000000000DEM000";
/** 2026-09-21T16:26:40Z. Every demo timestamp is relative to it. */
export const DEMO_T0 = 1_790_000_000_000;
const MIN = 60_000;

const region = (id: string, label: string, color: string, x: number): CanvasNode =>
  ({ id, type: "group", label, color, x, y: 0, width: 900, height: 700 }) as unknown as CanvasNode;

const seatNode = (id: string, name: string, harness: string, x: number, y: number): CanvasNode =>
  ({
    id,
    type: "text",
    text: name,
    x,
    y,
    width: 240,
    height: 96,
    ether: { entity: { kind: "agent", name: `local:demo-${id}` }, terminal: { harness } },
  }) as unknown as CanvasNode;

type DemoSeat = {
  readonly id: string;
  readonly name: string;
  readonly harness: string;
  readonly regionX: number;
  readonly slot: number;
  readonly control: AgentSeatState;
  readonly reason?: string;
  readonly process: "running" | "starting" | "stopped";
  readonly doneUnread?: boolean;
  readonly health?: ThreadHealthValue;
};

const SEATS: ReadonlyArray<DemoSeat> = [
  { id: "atlas", name: "Atlas", harness: "claude", regionX: 0, slot: 0, control: "idle", process: "running" },
  { id: "forge", name: "Forge", harness: "codex", regionX: 0, slot: 1, control: "attention", reason: "permission prompt", process: "running" },
  { id: "relay", name: "Relay", harness: "claude", regionX: 0, slot: 2, control: "working", process: "running", health: "going_well" },
  { id: "quill", name: "Quill", harness: "claude", regionX: 1000, slot: 0, control: "idle", process: "running" },
  { id: "prism", name: "Prism", harness: "amp", regionX: 1000, slot: 1, control: "idle", process: "running", doneUnread: true },
  { id: "ember", name: "Ember", harness: "codex", regionX: 1000, slot: 2, control: "idle", process: "running", health: "waiting_on_operator" },
  { id: "sage", name: "Sage", harness: "hermes", regionX: 2000, slot: 0, control: "working", process: "running", health: "thrashing" },
  { id: "lumen", name: "Lumen", harness: "claude", regionX: 2000, slot: 1, control: "idle", process: "stopped" },
];

const DOC: CanvasDoc = {
  nodes: [
    region("r-backend", "Backend", "4", 0),
    region("r-frontend", "Frontend", "5", 1000),
    region("r-research", "Research", "6", 2000),
    ...SEATS.map((seat) => seatNode(seat.id, seat.name, seat.harness, seat.regionX + 40 + seat.slot * 280, 120)),
  ],
  edges: [],
};

const reading = (seat: DemoSeat, value: ThreadHealthValue, at: number): ThreadHealthReading => ({
  bindingId: `local:demo-${seat.id}`,
  value,
  confidence: 0.93,
  observedAt: at,
  provenance: { source: "jev", assessmentId: `demo-${seat.id}`, questionId: `health.${value}`, packVersion: "awareness-pack/2" },
  signals: [{ value, probability: 0.93, questionId: `health.${value}` }],
});

const INITIAL_SIGNALS: ReadonlyArray<AgentSignal> = [
  {
    signalId: "sig_demo_blocked",
    canvasName: DEMO_CANVAS,
    nodeId: "atlas",
    kind: "blocked",
    text: "Need the staging database password to run the migration.",
    detail: "The migration step reads `STAGING_DB_URL`. It is not set in this shell.",
    createdAt: DEMO_T0 - 12 * MIN,
    state: "open",
  },
  {
    signalId: "sig_demo_escalate",
    canvasName: DEMO_CANVAS,
    nodeId: "quill",
    kind: "escalate",
    text: "Should the empty state use the illustration or plain text?",
    createdAt: DEMO_T0 - 7 * MIN,
    state: "open",
  },
  {
    signalId: "sig_demo_feedback",
    canvasName: DEMO_CANVAS,
    nodeId: "prism",
    kind: "feedback",
    text: "The pricing page is ready for review.",
    detail: "- New tier table\n- Annual toggle\n- FAQ moved below the fold",
    createdAt: DEMO_T0 - 3 * MIN,
    state: "open",
  },
];

type DemoMail = Omit<CompanionMail, "canvasName">;

const INITIAL_MAIL: ReadonlyArray<DemoMail> = [
  { messageId: "01J9DEMOMAIL0000000000000A1", nodeId: "atlas", direction: "to_seat", from: { kind: "operator" }, text: "Run the schema migration against staging.", at: DEMO_T0 - 40 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000A2", nodeId: "atlas", direction: "to_seat", from: { kind: "seat", nodeId: "relay", name: "Relay" }, text: "The API tests pass on my branch.", at: DEMO_T0 - 25 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000A3", nodeId: "atlas", direction: "from_seat", from: { kind: "seat", nodeId: "atlas", name: "Atlas" }, text: "Relay, hold the deploy until the migration lands.", at: DEMO_T0 - 20 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000B1", nodeId: "quill", direction: "to_seat", from: { kind: "operator" }, text: "Design the empty state for the inbox.", at: DEMO_T0 - 30 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000C1", nodeId: "lumen", direction: "to_seat", from: { kind: "operator" }, text: "Summarize the three papers when you are back.", at: DEMO_T0 - 5 * MIN, delivery: "waiting_for_seat" },
];

const QUICK_REPLIES = ["Yes, go ahead.", "No, stop here.", "Use your judgment.", "I'll look at it shortly."];

/** A fresh demo world; every connection gets its own. */
export const makeDemoBackend = (): CompanionBackend & {
  readonly revision: () => number;
  readonly takeSignalChanges: (since: number) => { readonly signals: ReadonlyArray<AgentSignal>; readonly seq: number };
} => {
  let clock = DEMO_T0;
  let revision = 0;
  const signals = new Map(INITIAL_SIGNALS.map((signal) => [signal.signalId, signal] as const));
  const signalLog: Array<{ readonly seq: number; readonly signal: AgentSignal }> = [];
  const mail: DemoMail[] = [...INITIAL_MAIL];
  let mailSeq = 0;
  const now = (): number => clock;
  const tick = (): number => {
    clock += 1_000;
    revision += 1;
    return clock;
  };
  const noteSignal = (signal: AgentSignal): void => {
    signals.set(signal.signalId, signal);
    signalLog.push({ seq: revision, signal });
  };

  const healthOf = (seat: DemoSeat): { reading: ThreadHealthReading; feed: FeedHealth } | undefined => {
    if (!seat.health) return undefined;
    const r = reading(seat, seat.health, DEMO_T0 - MIN);
    return {
      reading: r,
      feed: {
        value: r.value,
        tone: THREAD_HEALTH_TONE[r.value],
        label: THREAD_HEALTH_LABEL[r.value],
        confidence: r.confidence,
        observedAt: r.observedAt,
        stale: false,
      },
    };
  };

  const feedNow = () => {
    const attentionByNodeId = new Map(
      SEATS.filter((seat) => seat.control === "attention").map(
        (seat) => [seat.id, { reason: seat.reason ?? "", at: DEMO_T0 - 2 * MIN }] as const,
      ),
    );
    const healthByNodeId = new Map(
      SEATS.flatMap((seat) => {
        const health = healthOf(seat);
        return health ? [[seat.id, { reading: health.reading, fresh: true }] as const] : [];
      }),
    );
    return buildOperatorFeed({
      canvasName: DEMO_CANVAS,
      nowMs: clock,
      seats: feedSeatsFromDoc(DOC, { nameOf: (node) => (node as { text?: string }).text ?? node.id, attentionByNodeId, healthByNodeId }),
      signals: [...signals.values()],
    });
  };

  const seatsNow = () => {
    const feedSeats = feedSeatsFromDoc(DOC, { nameOf: (node) => (node as { text?: string }).text ?? node.id });
    const rollups = rollupSeatSignals([...signals.values()].filter((signal) => signal.state === "open"));
    return SEATS.map((seat) => {
      const entry = feedSeats.find((candidate) => candidate.seat.nodeId === seat.id)!;
      const rollup = rollups.get(seat.id);
      const health = healthOf(seat);
      return companionSeat({
        seat: entry.seat,
        region: entry.region,
        control: { state: seat.control, reason: seat.reason ?? "", at: DEMO_T0 - 2 * MIN },
        process: seat.process,
        ...(seat.doneUnread ? { doneUnread: true } : {}),
        ...(rollup ? { signal: { kind: rollup.kind, signalId: rollup.signal.signalId, openCount: rollup.openCount } } : {}),
        ...(health ? { health: health.feed } : {}),
      });
    });
  };

  const known = (canvasName: string) => canvasName === DEMO_CANVAS;
  const seatExists = (nodeId: string) => SEATS.some((seat) => seat.id === nodeId);
  const appendOperatorMail = (nodeId: string, text: string, at: number): CompanionMail => {
    const seat = SEATS.find((candidate) => candidate.id === nodeId)!;
    mailSeq += 1;
    const message: DemoMail = {
      messageId: `01J9DEMOSENT${String(mailSeq).padStart(14, "0")}`,
      nodeId,
      direction: "to_seat",
      from: { kind: "operator" },
      text,
      at,
      delivery: seat.process === "stopped" ? "waiting_for_seat" : "delivered",
    };
    mail.push(message);
    return { ...message, canvasName: DEMO_CANVAS };
  };

  return {
    now,
    revision: () => revision,
    takeSignalChanges: (since) => ({
      signals: signalLog.filter((entry) => entry.seq > since).map((entry) => entry.signal),
      seq: revision,
    }),
    pairComplete: async () => outcomeFail("invalid", "The demo is already paired."),
    canvases: async () =>
      outcomeOk([
        { canvasName: DEMO_CANVAS, title: "Demo", active: true, playing: true, needsYou: feedNow().count },
      ]),
    feeds: async (canvasName) =>
      canvasName === undefined || known(canvasName) ? outcomeOk([feedNow()]) : outcomeFail("not-found", "No such canvas."),
    seats: async (canvasName) => (known(canvasName) ? outcomeOk(seatsNow()) : outcomeFail("not-found", "No such canvas.")),
    answerSignal: async (signalId, text) => {
      const signal = signals.get(signalId);
      if (!signal) return outcomeFail("not-found", `No signal ${signalId}.`);
      if (signal.state !== "open") return outcomeFail("conflict", "That signal is no longer open.", signal);
      const at = tick();
      const answered: AgentSignal = { ...signal, state: "answered", response: { text, at }, closedAt: at };
      noteSignal(answered);
      appendOperatorMail(signal.nodeId, text, at);
      return outcomeOk(answered);
    },
    dismissSignal: async (signalId) => {
      const signal = signals.get(signalId);
      if (!signal) return outcomeFail("not-found", `No signal ${signalId}.`);
      if (signal.state !== "open") return outcomeFail("conflict", "That signal is no longer open.", signal);
      const at = tick();
      const dismissed: AgentSignal = { ...signal, state: "dismissed", closedAt: at };
      noteSignal(dismissed);
      return outcomeOk(dismissed);
    },
    mailList: async (canvasName, nodeId, limit) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      return outcomeOk(
        mail
          .filter((message) => message.nodeId === nodeId)
          .sort((a, b) => b.at - a.at || b.messageId.localeCompare(a.messageId))
          .slice(0, limit)
          .map((message) => ({ ...message, canvasName: DEMO_CANVAS })),
      );
    },
    mailSend: async (canvasName, nodeId, text) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      return outcomeOk(appendOperatorMail(nodeId, text, tick()));
    },
    quickReplies: async () => outcomeOk(QUICK_REPLIES),
    portrait: async (portraitIdentity, size, theme) => outcomeOk(companionPortraitSvg({ portraitIdentity, size, theme })),
  };
};

/** The demo as a session host: one world, changes announced after each write. */
export const makeDemoHost = (options: { readonly appVersion?: string } = {}): CompanionHost => {
  const backend = makeDemoBackend();
  const allowWrite = makeWriteLimiter();
  let waiters: Array<() => void> = [];
  const wake = (): void => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  };
  const cursorOf = (seq: number): string => `demo:${seq}`;
  const seqOf = (cursor: string | undefined): number | undefined => {
    const match = /^demo:(\d+)$/u.exec(cursor ?? "");
    return match ? Number(match[1]) : undefined;
  };

  return {
    hello: async () => ({
      ok: true,
      hello: {
        appVersion: options.appVersion ?? "demo",
        deviceId: DEMO_DEVICE_ID,
        deviceName: "Demo phone",
        station: "Junto demo",
        serverTime: backend.now(),
      },
    }),
    call: async (frame: CompanionRequestFrame): Promise<CompanionResponseFrame> => {
      const before = backend.revision();
      const response = await handleCompanionRequest(frame, {
        backend,
        device: { deviceId: DEMO_DEVICE_ID, state: "paired" },
        allowWrite,
      });
      if (backend.revision() !== before) wake();
      return response;
    },
    waitChange: async (cursor, waitMs): Promise<CompanionChange> => {
      const since = seqOf(cursor);
      if (since === undefined) {
        return { cursor: cursorOf(backend.revision()), changed: false, signals: [], reset: cursor !== undefined };
      }
      if (backend.revision() === since) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve();
          }, waitMs);
          const done = (): void => {
            clearTimeout(timer);
            resolve();
          };
          waiters.push(done);
        });
      }
      const changes = backend.takeSignalChanges(since);
      return {
        cursor: cursorOf(changes.seq),
        changed: changes.seq !== since,
        signals: changes.signals,
        reset: false,
      };
    },
  };
};

/** For tests: a demo request frame. */
export const demoRequest = (id: string, op: CompanionRequestFrame["op"], args: object = {}): string =>
  JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id, op, args });

