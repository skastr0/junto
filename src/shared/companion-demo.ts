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
  COMPANION_SEAT_HISTORY_LIMIT,
  type CompanionActivity,
  type CompanionMail,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
} from "./companion-protocol";
import { buildOperatorFeed, feedSeatsFromDoc, type FeedHealth } from "./operator-feed";
import { THREAD_HEALTH_LABEL, THREAD_HEALTH_TONE, type ThreadHealthReading, type ThreadHealthValue } from "./thread-health";
import {
  DEMO_ACTIVITY,
  DEMO_ACTIVITY_AT,
  DEMO_BRIEFINGS,
  DEMO_CANVAS,
  DEMO_CANVAS_TITLE,
  DEMO_DEVICE_ID,
  DEMO_DEVICE_NAME,
  DEMO_HEALTH_CONFIDENCE,
  DEMO_HEALTH_OBSERVED_AT,
  DEMO_MAIL,
  DEMO_PREAMBLES,
  DEMO_QUICK_REPLIES,
  DEMO_REGIONS,
  DEMO_SEATS,
  DEMO_SIGNALS,
  DEMO_STATION,
  DEMO_T0,
  demoSeatPosition,
  type DemoMail,
  type DemoRegion,
  type DemoSeat,
} from "./wire/companion-demo-fixture";

export { DEMO_CANVAS, DEMO_DEVICE_ID, DEMO_T0 } from "./wire/companion-demo-fixture";

const region = (r: DemoRegion): CanvasNode =>
  ({ id: r.id, type: "group", label: r.label, color: r.color, x: r.x, y: r.y, width: r.width, height: r.height }) as unknown as CanvasNode;

const seatNode = (seat: DemoSeat): CanvasNode =>
  ({
    id: seat.id,
    type: "text",
    text: seat.name,
    ...demoSeatPosition(seat),
    width: 240,
    height: 96,
    ether: { entity: { kind: "agent", name: `local:demo-${seat.id}` }, terminal: { harness: seat.harness } },
  }) as unknown as CanvasNode;

const SEATS = DEMO_SEATS;
const DOC: CanvasDoc = { nodes: [...DEMO_REGIONS.map(region), ...SEATS.map(seatNode)], edges: [] };

const reading = (seat: DemoSeat, value: ThreadHealthValue, at: number): ThreadHealthReading => ({
  bindingId: `local:demo-${seat.id}`,
  value,
  confidence: DEMO_HEALTH_CONFIDENCE,
  observedAt: at,
  provenance: { source: "jev", assessmentId: `demo-${seat.id}`, questionId: `health.${value}`, packVersion: "awareness-pack/2" },
  signals: [{ value, probability: DEMO_HEALTH_CONFIDENCE, questionId: `health.${value}` }],
});

/** A fresh demo world; every connection gets its own. */
export const makeDemoBackend = (): CompanionBackend & {
  readonly revision: () => number;
  readonly takeSignalChanges: (since: number) => { readonly signals: ReadonlyArray<AgentSignal>; readonly seq: number };
} => {
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
        control: { state: seat.control, reason: seat.reason ?? "", at: DEMO_ACTIVITY_AT },
        process: seat.process,
        ...(seat.doneUnread ? { doneUnread: true } : {}),
        ...(rollup ? { signal: { kind: rollup.kind, signalId: rollup.signal.signalId, openCount: rollup.openCount } } : {}),
        ...(health ? { health: health.feed } : {}),
      });
    });
  };

  const known = (canvasName: string) => canvasName === DEMO_CANVAS;
  const regionIdOf = (nodeId: string): string | null =>
    feedSeatsFromDoc(DOC, { nameOf: (node) => node.id }).find((entry) => entry.seat.nodeId === nodeId)?.region.regionId ?? null;
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
    mailSend: async (canvasName, nodeId, text) => {
      if (!known(canvasName) || !seatExists(nodeId)) return outcomeFail("not-found", "No such seat.");
      return outcomeOk(appendOperatorMail(nodeId, text, tick()));
    },
    quickReplies: async () => outcomeOk(DEMO_QUICK_REPLIES),
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

