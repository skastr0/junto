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

import { asCanvasName, asNodeId, asWireId, canvasFromOpened, type BindingId, type Canvas, type NodeOf } from "./model";
import { companionCanvasDrawn } from "./companion-canvas";
import type { AgentSignal } from "./agent-signals";
import { rollupSeatSignals } from "./agent-signals";
import {
  handleCompanionRequest,
  makeCompanionGates,
  makeWriteLimiter,
  outcomeFail,
  outcomeOk,
  type CompanionBackend,
  type CompanionMailThread,
} from "./companion-core";
import { companionConnected, companionThreadMessages, companionThreads } from "./companion-threads";
import { seatMailThreadMessages, seatMailThreads, type MailThreadsInput } from "./mail-threads";
import { makeAgentMessage, makeUserMessage } from "./task";
import type { Message } from "./work-model";
import { OPERATOR_SEAT_ID } from "./work-reference";
import { companionPortraitSvg } from "./companion-portrait";
import type { CompanionChange, CompanionHost } from "./companion-session";
import { companionSeat } from "./companion-seats";
import {
  COMPANION_PROTOCOL,
  COMPANION_SEAT_HISTORY_LIMIT,
  type CompanionActivity,
  type CompanionMachineLogLevel,
  type CompanionMail,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
  type CompanionThreadMessage,
} from "./companion-protocol";
import { buildOperatorFeed, feedSeatsFromCanvas, type FeedHealth } from "./operator-feed";

/** One thread mail as the store holds it: the mailbox it sits in, and the row. */
const demoThreadRow = (message: CompanionThreadMessage): { readonly nodeId: string; readonly row: Message } => {
  const operator = message.from.kind === "operator";
  const metadata = {
    factoryMail: true,
    mailKind: "prompt",
    fromSeat: message.from.kind === "operator" ? OPERATOR_SEAT_ID : `seat_demo_${message.from.nodeId}`,
    senderNodeId: message.from.kind === "operator" ? "operator" : message.from.nodeId,
    senderName: message.from.kind === "operator" ? "operator" : message.from.name,
    senderGeneration: operator ? "operator" : "demo",
    senderHarness: "unknown",
    // A thread's root carries no threadId; its id is the thread.
    ...(message.threadId === message.messageId ? {} : { threadId: message.threadId }),
    ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
    ...(message.mentions === undefined ? {} : { mentions: message.mentions.map((seat) => seat.nodeId) }),
  };
  const to = message.to[0]!;
  const base = { messageId: message.messageId, text: message.text, contextId: DEMO_CANVAS };
  if (to.kind === "operator" && message.from.kind === "seat") {
    return { nodeId: message.from.nodeId, row: makeAgentMessage({ ...base, metadata: { ...metadata, toNodeId: "operator" } }) };
  }
  return { nodeId: to.kind === "seat" ? to.nodeId : "", row: makeUserMessage({ ...base, metadata }) };
};

const DEMO_LOG_LEVELS: ReadonlyArray<CompanionMachineLogLevel> = ["trace", "debug", "info", "warn", "error", "fatal"];
import { THREAD_HEALTH_LABEL, THREAD_HEALTH_TONE, type ThreadHealthReading, type ThreadHealthValue } from "./thread-health";
import {
  DEMO_ACTIVITY,
  DEMO_ACTIVITY_AT,
  DEMO_BRIEFINGS,
  DEMO_CANVAS,
  DEMO_CANVAS_TITLE,
  DEMO_CONNECTED,
  DEMO_CONTENT,
  DEMO_DEVICE_ID,
  DEMO_DEVICE_NAME,
  DEMO_HEALTH_CONFIDENCE,
  DEMO_HEALTH_OBSERVED_AT,
  DEMO_MACHINES,
  DEMO_MAIL,
  DEMO_THREAD_MAIL,
  demoMailId,
  DEMO_PREAMBLES,
  DEMO_QUICK_REPLIES,
  DEMO_REGIONS,
  DEMO_SEATS,
  DEMO_SIGNALS,
  DEMO_STATION,
  DEMO_T0,
  DEMO_TAILNET,
  DEMO_WIRES,
  demoSeatPosition,
  type DemoMail,
  type DemoRegion,
  type DemoSeat,
} from "./wire/companion-demo-fixture";

export { DEMO_CANVAS, DEMO_DEVICE_ID, DEMO_T0 } from "./wire/companion-demo-fixture";

const region = (r: DemoRegion, z: number): NodeOf<"region"> =>
  ({ ...r, id: asNodeId(r.id), kind: "region", z, hold: false });

const seatNode = (seat: DemoSeat, z: number, machineName: string): NodeOf<"agent"> => ({
  id: asNodeId(seat.id), kind: "agent", label: seat.name,
  ...demoSeatPosition(seat), width: 240, height: 96, z,
  agentKey: `local:demo-${seat.id}`, host: machineName as NodeOf<"agent">["host"], overseer: false,
  bindingId: `demo-${seat.id}` as BindingId, harness: seat.harness,
});

const SEATS = DEMO_SEATS;
/** The demo canvas, its seats on the machine the demo runs on. */
const demoCanvas = (machineName: string) => canvasFromOpened({
  canvas: asCanvasName(DEMO_CANVAS), seq: 0,
  nodes: [...DEMO_REGIONS.map(region), ...SEATS.map((seat, index) => seatNode(seat, DEMO_REGIONS.length + index, machineName))],
  wires: DEMO_WIRES.map((wire) => ({ ...wire, id: asWireId(wire.id), from: asNodeId(wire.from), to: asNodeId(wire.to) })),
});

/** The seat a mail went to comes to the front: the demo's one canvas change, so a transcript holds a canvas.changed. */
const toFront = (canvas: Canvas, nodeId: string): Canvas => {
  const node = canvas.nodes.get(asNodeId(nodeId));
  const top = Math.max(...[...canvas.nodes.values()].map((candidate) => candidate.z));
  if (node === undefined || node.z === top) return canvas;
  return { ...canvas, nodes: new Map(canvas.nodes).set(node.id, { ...node, z: top + 1 }) };
};

const reading = (seat: DemoSeat, value: ThreadHealthValue, at: number): ThreadHealthReading => ({
  bindingId: `local:demo-${seat.id}`,
  value,
  confidence: DEMO_HEALTH_CONFIDENCE,
  observedAt: at,
  provenance: { source: "jev", assessmentId: `demo-${seat.id}`, questionId: `health.${value}`, packVersion: "awareness-pack/2" },
  signals: [{ value, probability: DEMO_HEALTH_CONFIDENCE, questionId: `health.${value}` }],
});

/** A fresh demo world on the machine named; every connection gets its own. */
/** Draws a portrait's SVG as PNG bytes; the caller brings it, so the demo stays platform-free. */
export type DemoPortraitPng = (svg: string, size: number) => Promise<Uint8Array>;

export const makeDemoBackend = (machineName: string, portraitPng?: DemoPortraitPng): CompanionBackend & {
  readonly revision: () => number;
  readonly takeSignalChanges: (since: number) => { readonly signals: ReadonlyArray<AgentSignal>; readonly seq: number };
} => {
  let CANVAS = demoCanvas(machineName);
  let clock = DEMO_T0;
  let revision = 0;
  const signals = new Map(DEMO_SIGNALS.map((signal) => [signal.signalId, signal] as const));
  const signalLog: Array<{ readonly seq: number; readonly signal: AgentSignal }> = [];
  const mail: DemoMail[] = [...DEMO_MAIL];
  const activity = new Map(Object.entries(DEMO_ACTIVITY).map(([nodeId, lines]) => [nodeId, [...lines]] as const));
  const noteActivity = (nodeId: string, line: CompanionActivity): void => {
    activity.set(nodeId, [line, ...(activity.get(nodeId) ?? [])]);
  };
  let mailSeq = 0;
  const threadRows = DEMO_THREAD_MAIL.map(demoThreadRow);
  const threadsInput = (): MailThreadsInput => ({
    mailboxes: SEATS.map((seat) => ({
      nodeId: seat.id,
      messages: threadRows.filter((entry) => entry.nodeId === seat.id).map((entry) => entry.row),
    })),
    nameOf: (nodeId) => SEATS.find((seat) => seat.id === nodeId)?.name,
  });
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
    const r = reading(seat, seat.health, DEMO_HEALTH_OBSERVED_AT);
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
        (seat) => [seat.id, { reason: seat.reason ?? "", at: DEMO_ACTIVITY_AT }] as const,
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
      seats: feedSeatsFromCanvas(CANVAS, { attentionByNodeId, healthByNodeId }),
      signals: [...signals.values()],
    });
  };

  const seatsNow = () => {
    const feedSeats = feedSeatsFromCanvas(CANVAS);
    const rollups = rollupSeatSignals([...signals.values()].filter((signal) => signal.state === "open"));
    return SEATS.map((seat) => {
      const entry = feedSeats.find((candidate) => candidate.seat.nodeId === seat.id)!;
      const rollup = rollups.get(seat.id);
      const health = healthOf(seat);
      return companionSeat({
        seat: entry.seat,
        region: entry.region,
        control: { state: seat.control, reason: seat.reason ?? "", at: DEMO_ACTIVITY_AT },
        process: seat.process,
        ...(seat.doneUnread ? { doneUnread: true } : {}),
        ...(rollup ? { signal: { kind: rollup.kind, signalId: rollup.signal.signalId, openCount: rollup.openCount } } : {}),
        ...(health ? { health: health.feed } : {}),
        ring: { since: DEMO_ACTIVITY_AT },
      });
    });
  };

  const known = (canvasName: string) => canvasName === DEMO_CANVAS;
  const regionIdOf = (nodeId: string): string | null =>
    feedSeatsFromCanvas(CANVAS).find((entry) => entry.seat.nodeId === nodeId)?.region.regionId ?? null;
  const seatExists = (nodeId: string) => SEATS.some((seat) => seat.id === nodeId);
  const appendOperatorMail = (
    nodeId: string,
    text: string,
    at: number,
    thread: { readonly threadId?: string; readonly inReplyTo?: string; readonly mentions?: ReadonlyArray<string> } = {},
  ): CompanionMail => {
    const seat = SEATS.find((candidate) => candidate.id === nodeId)!;
    mailSeq += 1;
    const messageId = demoMailId(at, "SENT", mailSeq);
    const threadId = thread.threadId ?? messageId;
    const message: DemoMail = {
      messageId,
      nodeId,
      direction: "to_seat",
      from: { kind: "operator" },
      text,
      at,
      delivery: seat.process === "stopped" ? "waiting_for_seat" : "delivered",
      threadId,
      ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
    };
    mail.push(message);
    const name = (id: string) => SEATS.find((candidate) => candidate.id === id)?.name ?? id;
    const mentions = (thread.mentions ?? []).map((id) => ({ kind: "seat" as const, nodeId: id, name: name(id) }));
    threadRows.push(
      demoThreadRow({
        messageId,
        threadId,
        ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
        from: { kind: "operator" },
        to: [{ kind: "seat", nodeId, name: seat.name }],
        mine: true,
        text,
        at,
        ...(mentions.length === 0 ? {} : { mentions }),
      }),
    );
    noteActivity(nodeId, { at, label: "got your mail", kind: "mail" });
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
        { canvasName: DEMO_CANVAS, title: DEMO_CANVAS_TITLE, active: true, playing: true, needsYou: feedNow().count },
      ]),
    feeds: async (canvasName) =>
      canvasName === undefined || known(canvasName) ? outcomeOk([feedNow()]) : outcomeFail("not-found", "No such canvas."),
    seats: async (canvasName) => (known(canvasName) ? outcomeOk(seatsNow()) : outcomeFail("not-found", "No such canvas.")),
    seatDetail: async (canvasName, nodeId) => {
      const seat = known(canvasName) ? seatsNow().find((candidate) => candidate.nodeId === nodeId) : undefined;
      if (!seat) return outcomeFail("not-found", "No such seat.");
      const regionId = regionIdOf(nodeId);
      const briefing = regionId === null ? undefined : DEMO_BRIEFINGS[regionId];
      return outcomeOk({
        ...seat,
        ...(briefing !== undefined ? { briefing } : {}),
        preambles: (DEMO_PREAMBLES[nodeId] ?? []).filter((preamble) => preamble.expiresAt > clock),
        signals: [...signals.values()]
          .filter((signal) => signal.nodeId === nodeId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, COMPANION_SEAT_HISTORY_LIMIT),
        activity: [...(activity.get(nodeId) ?? [])].slice(0, COMPANION_SEAT_HISTORY_LIMIT),
        connected: companionConnected(
          (DEMO_CONNECTED[nodeId] ?? []).map((id) => ({ nodeId: id, name: SEATS.find((peer) => peer.id === id)?.name ?? id })),
        ),
      });
    },
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
      noteActivity(signal.nodeId, { at, label: `${signal.kind} dismissed`, kind: "signal" });
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
    mailSend: async (canvasName, nodeId, text, thread: CompanionMailThread = {}) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      const body = text.trim();
      if (!body) return outcomeFail("invalid", "Mail needs some text.");
      const mentions = [...new Set(thread.mentions ?? [])].filter((id) => id !== nodeId);
      if (mentions.some((id) => !(DEMO_CONNECTED[nodeId] ?? []).includes(id))) {
        return outcomeFail("invalid", "A mentioned seat is not connected to this one.");
      }
      const threads = seatMailThreads(threadsInput(), nodeId);
      let threadId: string | undefined;
      if (thread.inReplyTo !== undefined) {
        const parent = threads
          .flatMap((held) => seatMailThreadMessages(threadsInput(), nodeId, held.threadId))
          .find((message) => message.messageId === thread.inReplyTo);
        if (parent === undefined) return outcomeFail("not-found", "That mail is not in this seat's threads.");
        if (thread.threadId !== undefined && thread.threadId !== parent.threadId) {
          return outcomeFail("invalid", "That mail is in another thread.");
        }
        threadId = parent.threadId;
      } else if (thread.threadId !== undefined) {
        if (!threads.some((held) => held.threadId === thread.threadId)) {
          return outcomeFail("not-found", "That thread is not one of this seat's.");
        }
        threadId = thread.threadId;
      }
      CANVAS = toFront(CANVAS, nodeId);
      return outcomeOk(
        appendOperatorMail(nodeId, body, tick(), {
          ...(threadId === undefined ? {} : { threadId }),
          ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
          mentions,
        }),
      );
    },
    threads: async (canvasName, nodeId) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      return outcomeOk(companionThreads(seatMailThreads(threadsInput(), nodeId)));
    },
    thread: async (canvasName, nodeId, threadId) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      const messages = seatMailThreadMessages(threadsInput(), nodeId, threadId);
      if (messages.length === 0) return outcomeFail("not-found", "That thread is not one of this seat's.");
      return outcomeOk(companionThreadMessages(messages));
    },
    quickReplies: async () => outcomeOk(DEMO_QUICK_REPLIES),
    portrait: async (portraitIdentity, size, theme, format) => {
      const svg = companionPortraitSvg({ portraitIdentity, size, theme });
      if (format === "svg") return outcomeOk({ svg });
      if (portraitPng === undefined) return outcomeFail("unavailable", "Portraits as images are not in this demo.");
      return outcomeOk({ png: Buffer.from(await portraitPng(svg, size)).toString("base64") });
    },
    contentRange: async (ref, offset, length) => {
      const stored = DEMO_CONTENT.find((content) => content.ref.sha256 === ref.sha256);
      if (stored === undefined) return outcomeFail("unavailable");
      return outcomeOk(new TextEncoder().encode(stored.text).subarray(offset, offset + length));
    },
    machines: async () => outcomeOk(DEMO_MACHINES.map((entry) => entry.machine)),
    machine: async (name, minLevel) => {
      const entry = DEMO_MACHINES.find((candidate) => candidate.machine.name === name);
      if (entry === undefined) return outcomeFail("not-found", "No such machine on this Mac.");
      const rank = (level: CompanionMachineLogLevel): number => DEMO_LOG_LEVELS.indexOf(level);
      const logs = typeof entry.logs === "string"
        ? { unavailable: entry.logs }
        : { rows: entry.logs.filter((row) => minLevel === undefined || rank(row.level) >= rank(minLevel)), cut: false };
      return outcomeOk({ machine: entry.machine, status: entry.status, logs });
    },
    tailnetPeers: async () => outcomeOk({ available: true, peers: DEMO_TAILNET }),
    canvasScene: async (canvasName) => known(canvasName) ? outcomeOk(companionCanvasDrawn(CANVAS)) : outcomeFail("not-found", "No such canvas."),
  };
};

/** The demo as a session host: one world, changes announced after each write. */
export const makeDemoHost = (options: {
  readonly appVersion?: string;
  /** The machine the demo runs on; the caller knows it, the demo invents none. */
  readonly machineName: string;
  readonly portraitPng?: DemoPortraitPng;
}): CompanionHost => {
  const backend = makeDemoBackend(options.machineName, options.portraitPng);
  const allowWrite = makeWriteLimiter();
  const gates = makeCompanionGates();
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
        deviceName: DEMO_DEVICE_NAME,
        station: DEMO_STATION,
        serverTime: backend.now(),
      },
    }),
    call: async (frame: CompanionRequestFrame): Promise<CompanionResponseFrame> => {
      const before = backend.revision();
      const response = await handleCompanionRequest(frame, {
        backend,
        device: { deviceId: DEMO_DEVICE_ID, state: "paired" },
        allowWrite,
        gates,
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

