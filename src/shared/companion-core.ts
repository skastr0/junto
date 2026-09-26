/**
 * The companion request core: one decoded phone request in, one response
 * frame out. It owns everything that is protocol rather than data: the
 * pairing gate (a device in pairing may only `pair.complete`, a paired one may
 * never), the write rate limit, and the shape of each result. The data comes
 * from a `CompanionBackend`: the running app in main, or the built-in demo.
 */

import type { AgentSignal } from "./agent-signals";
import {
  COMPANION_ERROR_COPY,
  COMPANION_MAIL_DEFAULT_LIMIT,
  COMPANION_WRITE_LIMIT,
  COMPANION_WRITE_OPS,
  COMPANION_WRITE_WINDOW_MS,
  companionError,
  companionFail,
  companionOk,
  type CompanionCanvas,
  type CompanionError,
  type CompanionMail,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
  type CompanionSeat,
  type CompanionSeatDetail,
} from "./companion-protocol";
import type { OperatorFeed } from "./operator-feed";

export type CompanionOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: CompanionError };

export const outcomeOk = <A>(value: A): CompanionOutcome<A> => ({ ok: true, value });
export const outcomeFail = <A = never>(
  code: CompanionError["code"],
  message?: string,
  signal?: AgentSignal,
): CompanionOutcome<A> => ({ ok: false, error: companionError(code, message ?? COMPANION_ERROR_COPY[code], signal) });

export type CompanionBackend = {
  readonly now: () => number;
  readonly pairComplete: (input: {
    readonly deviceId: string;
    readonly publicKey: string;
    readonly deviceName: string;
  }) => Promise<CompanionOutcome<{ readonly deviceId: string }>>;
  readonly canvases: () => Promise<CompanionOutcome<ReadonlyArray<CompanionCanvas>>>;
  /** One feed per canvas; every canvas when the name is omitted. */
  readonly feeds: (canvasName?: string) => Promise<CompanionOutcome<ReadonlyArray<OperatorFeed>>>;
  readonly seats: (canvasName: string) => Promise<CompanionOutcome<ReadonlyArray<CompanionSeat>>>;
  readonly seatDetail: (canvasName: string, nodeId: string) => Promise<CompanionOutcome<CompanionSeatDetail>>;
  /** Not-open signals fail `conflict` with the signal as it stands. */
  readonly answerSignal: (signalId: string, text: string) => Promise<CompanionOutcome<AgentSignal>>;
  readonly dismissSignal: (signalId: string) => Promise<CompanionOutcome<AgentSignal>>;
  readonly mailList: (
    canvasName: string,
    nodeId: string,
    limit: number,
  ) => Promise<CompanionOutcome<ReadonlyArray<CompanionMail>>>;
  readonly mailSend: (canvasName: string, nodeId: string, text: string) => Promise<CompanionOutcome<CompanionMail>>;
  readonly quickReplies: () => Promise<CompanionOutcome<ReadonlyArray<string>>>;
  readonly portrait: (
    portraitIdentity: string,
    size: number,
    theme: "bright" | "dark",
  ) => Promise<CompanionOutcome<string>>;
};

export type CompanionDeviceView = {
  readonly deviceId: string;
  readonly state: "pairing" | "paired";
};

/**
 * Sliding-window write limiter, one per device. It keeps wall-clock time of
 * its own: a backend's clock (the demo's advances per write) is not a rate.
 */
export const makeWriteLimiter = (
  limit = COMPANION_WRITE_LIMIT,
  windowMs = COMPANION_WRITE_WINDOW_MS,
  clock: () => number = Date.now,
): (() => boolean) => {
  const stamps: number[] = [];
  return () => {
    const now = clock();
    while (stamps.length > 0 && now - stamps[0]! >= windowMs) stamps.shift();
    if (stamps.length >= limit) return false;
    stamps.push(now);
    return true;
  };
};

const respond = async <A>(
  id: string,
  outcome: Promise<CompanionOutcome<A>>,
  ok: (value: A) => CompanionResponseFrame,
): Promise<CompanionResponseFrame> => {
  try {
    const result = await outcome;
    return result.ok ? ok(result.value) : companionFail(id, result.error);
  } catch {
    return companionFail(id, companionError("internal", COMPANION_ERROR_COPY.internal));
  }
};

export const handleCompanionRequest = async (
  frame: CompanionRequestFrame,
  context: {
    readonly backend: CompanionBackend;
    readonly device: CompanionDeviceView;
    readonly allowWrite: () => boolean;
  },
): Promise<CompanionResponseFrame> => {
  const { backend, device } = context;
  const id = frame.id;

  if (device.state === "pairing" && frame.op !== "pair.complete") {
    return companionFail(id, companionError("invalid", "Finish pairing first."));
  }
  if (device.state === "paired" && frame.op === "pair.complete") {
    return companionFail(id, companionError("invalid", "This phone is already paired."));
  }
  if (COMPANION_WRITE_OPS.has(frame.op) && !context.allowWrite()) {
    return companionFail(id, companionError("rate-limited", COMPANION_ERROR_COPY["rate-limited"]));
  }

  switch (frame.op) {
    case "pair.complete":
      return respond(id, backend.pairComplete({ deviceId: device.deviceId, ...frame.args }), (value) =>
        companionOk(id, "pair.complete", value),
      );
    case "ping":
      return companionOk(id, "ping", { serverTime: backend.now() });
    case "canvases.list":
      return respond(id, backend.canvases(), (canvases) => companionOk(id, "canvases.list", { canvases }));
    case "feed.get":
    case "feed.subscribe": {
      const op = frame.op;
      return respond(id, backend.feeds(frame.args.canvasName), (feeds) => companionOk(id, op, { feeds }));
    }
    case "feed.unsubscribe":
      return companionOk(id, "feed.unsubscribe", {});
    case "seats.list":
      return respond(id, backend.seats(frame.args.canvasName), (seats) => companionOk(id, "seats.list", { seats }));
    case "seat.get":
      return respond(id, backend.seatDetail(frame.args.canvasName, frame.args.nodeId), (seat) =>
        companionOk(id, "seat.get", { seat }),
      );
    case "signal.answer":
      return respond(id, backend.answerSignal(frame.args.signalId, frame.args.text), (signal) =>
        companionOk(id, "signal.answer", { signal }),
      );
    case "signal.dismiss":
      return respond(id, backend.dismissSignal(frame.args.signalId), (signal) =>
        companionOk(id, "signal.dismiss", { signal }),
      );
    case "mail.list":
      return respond(
        id,
        backend.mailList(frame.args.canvasName, frame.args.nodeId, frame.args.limit ?? COMPANION_MAIL_DEFAULT_LIMIT),
        (messages) => companionOk(id, "mail.list", { messages }),
      );
    case "mail.send":
      return respond(id, backend.mailSend(frame.args.canvasName, frame.args.nodeId, frame.args.text), (message) =>
        companionOk(id, "mail.send", { message }),
      );
    case "quickReplies.get":
      return respond(id, backend.quickReplies(), (replies) => companionOk(id, "quickReplies.get", { replies }));
    case "portrait.get":
      return respond(
        id,
        backend.portrait(frame.args.portraitIdentity, frame.args.size, frame.args.theme),
        (svg) => companionOk(id, "portrait.get", { svg }),
      );
  }
};
