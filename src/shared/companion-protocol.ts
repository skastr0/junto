/**
 * junto-companion/1 — the phone companion protocol (docs/companion-protocol.md).
 *
 * This module is the machine source of truth for that document: every frame,
 * op, argument, result, event and error, as Effect Schema. The phone speaks it
 * over the SSH exec channel to `junto companion-stdio`, which relays each
 * request to the running app over the operator control socket.
 *
 * Reused, never copied: the feed shapes are `@shared/operator-feed`'s and the
 * signal shape is `@shared/agent-signals`'s, so the phone reads exactly what the
 * desktop feed reads.
 *
 * Decoding is lenient about unknown fields (the protocol is additive-only:
 * a newer phone may send an optional argument this build does not know yet)
 * and strict about everything it does know. Frame size is bounded in both
 * directions before any JSON is parsed or written.
 */

import { Result, Schema } from "effect";
import { AgentSignal, AgentSignalKind } from "./agent-signals";
import { FeedHealth, FeedRegion, OperatorFeed } from "./operator-feed";

export const COMPANION_PROTOCOL = "junto-companion/1" as const;

/** Phone to Mac. A larger frame is `too-large` and the channel closes. */
export const COMPANION_MAX_INBOUND_BYTES = 16 * 1024;
/** Mac to phone. */
export const COMPANION_MAX_OUTBOUND_BYTES = 512 * 1024;
/** The Mac closes a channel silent for this long. */
export const COMPANION_IDLE_CLOSE_MS = 120_000;
/** Write ops (answer, dismiss, send) allowed per window, per device. */
export const COMPANION_WRITE_LIMIT = 20;
export const COMPANION_WRITE_WINDOW_MS = 10_000;
/** A pairing QR, and the device record behind it, lives this long unused. */
export const COMPANION_PAIRING_TTL_MS = 10 * 60_000;
/** Answer and mail text bounds, the same as a desktop signal answer. */
export const COMPANION_MAX_TEXT = 8_000;
export const COMPANION_MAIL_DEFAULT_LIMIT = 50;
export const COMPANION_MAIL_MAX_LIMIT = 200;

// --- primitives --------------------------------------------------------------

const bounded = (min: number, max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(min)), Schema.check(Schema.isMaxLength(max)));

const intBetween = (minimum: number, maximum: number) =>
  Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum, maximum })));

/** A paired phone: `dev_` and a ULID. */
export const CompanionDeviceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/u)),
);
export type CompanionDeviceId = typeof CompanionDeviceId.Type;

/** Chosen by the phone, unique per connection. */
export const CompanionRequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
);

const CanvasName = bounded(1, 256);
const NodeId = bounded(1, 256);
const Text = bounded(1, COMPANION_MAX_TEXT);

/**
 * A phone public key, exactly `<type> <base64>`: no options, no comment, no
 * whitespace beyond the one separator. It lands in authorized_keys, so this
 * pattern is also what keeps a phone from smuggling options into that file.
 */
export const CompanionPublicKey = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(2_048)),
  Schema.check(Schema.isPattern(/^(?:ecdsa-sha2-nistp256|ssh-ed25519) [A-Za-z0-9+/]{16,}={0,3}$/u)),
);
export type CompanionPublicKey = typeof CompanionPublicKey.Type;

/** Shown in Settings; one line of plain text. */
export const CompanionDeviceName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/u)),
);

// --- data shapes -------------------------------------------------------------

export const CompanionCanvas = Schema.Struct({
  canvasName: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
  playing: Schema.Boolean,
  needsYou: Schema.Number,
});
export type CompanionCanvas = typeof CompanionCanvas.Type;

/** What the seat ring shows, in the desktop's words. */
export const COMPANION_SEAT_STATES = [
  "working",
  "waiting_on_you",
  "needs_input",
  "blocked",
  "trouble",
  "done_unread",
  "resting",
  "starting",
  "stopped",
  "offline",
] as const;
export const CompanionSeatState = Schema.Literals(COMPANION_SEAT_STATES);
export type CompanionSeatState = typeof CompanionSeatState.Type;

export const CompanionSeat = Schema.Struct({
  nodeId: Schema.String,
  name: Schema.String,
  portraitIdentity: Schema.String,
  harness: Schema.optionalKey(Schema.String),
  region: FeedRegion,
  state: CompanionSeatState,
  line: Schema.String,
  signal: Schema.optionalKey(
    Schema.Struct({ kind: AgentSignalKind, signalId: Schema.String, openCount: Schema.Number }),
  ),
  health: Schema.optionalKey(FeedHealth),
  lastActivityAt: Schema.optionalKey(Schema.Number),
});
export type CompanionSeat = typeof CompanionSeat.Type;

export const CompanionMailFrom = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("seat"), nodeId: Schema.String, name: Schema.String }),
]);

export const CompanionMail = Schema.Struct({
  messageId: Schema.String,
  canvasName: Schema.String,
  nodeId: Schema.String,
  direction: Schema.Literals(["to_seat", "from_seat"]),
  from: CompanionMailFrom,
  text: Schema.String,
  at: Schema.Number,
  delivery: Schema.Literals(["delivered", "waiting_for_seat", "failed"]),
});
export type CompanionMail = typeof CompanionMail.Type;

export const CompanionHello = Schema.Struct({
  appVersion: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
  station: Schema.String,
  serverTime: Schema.Number,
});
export type CompanionHello = typeof CompanionHello.Type;

// --- ops ---------------------------------------------------------------------

export const COMPANION_OPS = [
  "pair.complete",
  "ping",
  "canvases.list",
  "feed.get",
  "feed.subscribe",
  "feed.unsubscribe",
  "seats.list",
  "signal.answer",
  "signal.dismiss",
  "mail.list",
  "mail.send",
  "quickReplies.get",
  "portrait.get",
] as const;
export const CompanionOpName = Schema.Literals(COMPANION_OPS);
export type CompanionOpName = typeof CompanionOpName.Type;

/** Ops that change something; these count against the write limit. */
export const COMPANION_WRITE_OPS: ReadonlySet<CompanionOpName> = new Set([
  "signal.answer",
  "signal.dismiss",
  "mail.send",
]);

const Empty = Schema.Struct({});

export const CompanionArgs = {
  "pair.complete": Schema.Struct({ publicKey: CompanionPublicKey, deviceName: CompanionDeviceName }),
  ping: Empty,
  "canvases.list": Empty,
  "feed.get": Schema.Struct({ canvasName: Schema.optionalKey(CanvasName) }),
  "feed.subscribe": Schema.Struct({ canvasName: Schema.optionalKey(CanvasName) }),
  "feed.unsubscribe": Empty,
  "seats.list": Schema.Struct({ canvasName: CanvasName }),
  "signal.answer": Schema.Struct({ signalId: bounded(1, 128), text: Text }),
  "signal.dismiss": Schema.Struct({ signalId: bounded(1, 128) }),
  "mail.list": Schema.Struct({
    canvasName: CanvasName,
    nodeId: NodeId,
    limit: Schema.optionalKey(intBetween(1, COMPANION_MAIL_MAX_LIMIT)),
  }),
  "mail.send": Schema.Struct({ canvasName: CanvasName, nodeId: NodeId, text: Text }),
  "quickReplies.get": Empty,
  "portrait.get": Schema.Struct({
    portraitIdentity: bounded(1, 256),
    size: intBetween(16, 1024),
    theme: Schema.Literals(["bright", "dark"]),
  }),
} as const satisfies Record<CompanionOpName, Schema.Top>;

export type CompanionArgsByOp = { readonly [Op in CompanionOpName]: (typeof CompanionArgs)[Op]["Type"] };

export const CompanionResults = {
  "pair.complete": Schema.Struct({ deviceId: Schema.String }),
  ping: Schema.Struct({ serverTime: Schema.Number }),
  "canvases.list": Schema.Struct({ canvases: Schema.Array(CompanionCanvas) }),
  "feed.get": Schema.Struct({ feeds: Schema.Array(OperatorFeed) }),
  "feed.subscribe": Schema.Struct({ feeds: Schema.Array(OperatorFeed) }),
  "feed.unsubscribe": Empty,
  "seats.list": Schema.Struct({ seats: Schema.Array(CompanionSeat) }),
  "signal.answer": Schema.Struct({ signal: AgentSignal }),
  "signal.dismiss": Schema.Struct({ signal: AgentSignal }),
  "mail.list": Schema.Struct({ messages: Schema.Array(CompanionMail) }),
  "mail.send": Schema.Struct({ message: CompanionMail }),
  "quickReplies.get": Schema.Struct({ replies: Schema.Array(Schema.String) }),
  "portrait.get": Schema.Struct({ svg: Schema.String }),
} as const satisfies Record<CompanionOpName, Schema.Top>;

export type CompanionResultByOp = { readonly [Op in CompanionOpName]: (typeof CompanionResults)[Op]["Type"] };

// --- errors ------------------------------------------------------------------

export const COMPANION_ERROR_CODES = [
  "app-not-running",
  "revoked",
  "unsupported-version",
  "invalid",
  "not-found",
  "conflict",
  "too-large",
  "rate-limited",
  "internal",
] as const;
export const CompanionErrorCode = Schema.Literals(COMPANION_ERROR_CODES);
export type CompanionErrorCode = typeof CompanionErrorCode.Type;

export const CompanionError = Schema.Struct({
  code: CompanionErrorCode,
  /** Short, plain, safe to show: never secrets, tokens or terminal contents. */
  message: bounded(1, 500),
  /** `conflict` only: the signal as it now stands. */
  signal: Schema.optionalKey(AgentSignal),
});
export type CompanionError = typeof CompanionError.Type;

// --- events ------------------------------------------------------------------

export const CompanionEvents = {
  hello: CompanionHello,
  "feed.changed": Schema.Struct({ feed: OperatorFeed }),
  "seat.changed": Schema.Struct({ canvasName: Schema.String, seat: CompanionSeat }),
  "signal.changed": Schema.Struct({ signal: AgentSignal }),
} as const;
export type CompanionEventName = keyof typeof CompanionEvents;
export type CompanionEventDataByName = {
  readonly [E in CompanionEventName]: (typeof CompanionEvents)[E]["Type"];
};

// --- frames ------------------------------------------------------------------

const V = Schema.Literal(COMPANION_PROTOCOL);

/** The envelope every phone frame must carry before its op is looked at. */
export const CompanionInboundEnvelope = Schema.Struct({
  v: Schema.String,
  type: Schema.Literal("request"),
  id: CompanionRequestId,
  op: Schema.String,
  args: Schema.optionalKey(Schema.Unknown),
});

const requestFrame = <Op extends CompanionOpName>(op: Op) =>
  Schema.Struct({
    v: V,
    type: Schema.Literal("request"),
    id: CompanionRequestId,
    op: Schema.Literal(op),
    args: CompanionArgs[op],
  });

export const CompanionRequestFrame = Schema.Union(COMPANION_OPS.map(requestFrame));
export type CompanionRequestFrame = {
  readonly [Op in CompanionOpName]: {
    readonly v: typeof COMPANION_PROTOCOL;
    readonly type: "request";
    readonly id: string;
    readonly op: Op;
    readonly args: CompanionArgsByOp[Op];
  };
}[CompanionOpName];

const responseOk = <Op extends CompanionOpName>(op: Op) =>
  Schema.Struct({
    v: V,
    type: Schema.Literal("response"),
    id: CompanionRequestId,
    ok: Schema.Literal(true),
    result: CompanionResults[op],
  });

export const CompanionResponseError = Schema.Struct({
  v: V,
  type: Schema.Literal("response"),
  id: CompanionRequestId,
  ok: Schema.Literal(false),
  error: CompanionError,
});

export const CompanionResponseFrame = Schema.Union([
  ...COMPANION_OPS.map(responseOk),
  CompanionResponseError,
]);
export type CompanionResponseFrame = typeof CompanionResponseFrame.Type;

const eventFrame = <E extends CompanionEventName>(event: E) =>
  Schema.Struct({
    v: V,
    type: Schema.Literal("event"),
    event: Schema.Literal(event),
    data: CompanionEvents[event],
  });

export const CompanionEventFrame = Schema.Union(
  (Object.keys(CompanionEvents) as CompanionEventName[]).map(eventFrame),
);
export type CompanionEventFrame = {
  readonly [E in CompanionEventName]: {
    readonly v: typeof COMPANION_PROTOCOL;
    readonly type: "event";
    readonly event: E;
    readonly data: CompanionEventDataByName[E];
  };
}[CompanionEventName];

/**
 * A connection-level error with no request to answer (revoked,
 * app-not-running, too-large, unsupported-version before an id is known). The
 * doc calls it an `error` frame; it is a response with an empty id.
 */
export const CompanionConnectionError = Schema.Struct({
  v: V,
  type: Schema.Literal("response"),
  id: Schema.Literal(""),
  ok: Schema.Literal(false),
  error: CompanionError,
});

export const CompanionOutboundFrame = Schema.Union([
  CompanionResponseFrame,
  CompanionConnectionError,
  CompanionEventFrame,
]);
export type CompanionOutboundFrame = typeof CompanionOutboundFrame.Type;

// --- builders ----------------------------------------------------------------

/**
 * A success response, checked against its op's own result schema. The wire
 * frame does not name its op, so only here can a result be held to the right
 * shape; a mismatch becomes an `internal` error for the same request.
 */
export const companionOk = <Op extends CompanionOpName>(
  id: string,
  op: Op,
  result: CompanionResultByOp[Op],
): CompanionResponseFrame => {
  const encoded = Schema.encodeUnknownResult(CompanionResults[op] as unknown as Schema.Codec<unknown>)(result);
  if (Result.isFailure(encoded)) return companionFail(id, companionError("internal", COMPANION_ERROR_COPY.internal));
  return { v: COMPANION_PROTOCOL, type: "response", id, ok: true, result: encoded.success } as CompanionResponseFrame;
};

export const companionFail = (id: string, error: CompanionError): CompanionResponseFrame => ({
  v: COMPANION_PROTOCOL,
  type: "response",
  id,
  ok: false,
  error,
});

export const companionError = (
  code: CompanionErrorCode,
  message: string,
  signal?: AgentSignal,
): CompanionError => ({ code, message, ...(signal ? { signal } : {}) });

export const companionEvent = <E extends CompanionEventName>(
  event: E,
  data: CompanionEventDataByName[E],
): CompanionEventFrame => ({ v: COMPANION_PROTOCOL, type: "event", event, data }) as CompanionEventFrame;

/** Plain messages for errors raised by the protocol itself. */
export const COMPANION_ERROR_COPY: Readonly<Record<CompanionErrorCode, string>> = {
  "app-not-running": "Junto is not open on the Mac.",
  revoked: "This phone was removed from Junto.",
  "unsupported-version": "This Mac speaks a different companion protocol.",
  invalid: "The request was not valid.",
  "not-found": "That is no longer there.",
  conflict: "That changed on the Mac.",
  "too-large": "The message was too large.",
  "rate-limited": "Too many changes at once. Try again in a moment.",
  internal: "Something went wrong on the Mac.",
};

// --- codec -------------------------------------------------------------------

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

const decodeEnvelope = Schema.decodeUnknownResult(CompanionInboundEnvelope);
const decodeRequestFrame = Schema.decodeUnknownResult(CompanionRequestFrame);
const decodeOutbound = Schema.decodeUnknownResult(CompanionOutboundFrame);
const encodeOutbound = Schema.encodeUnknownResult(CompanionOutboundFrame);

/**
 * One phone line, decoded. A failure carries the request id when one could be
 * read, so the reply still reaches the right request; `close` says whether the
 * protocol requires the channel to close after it.
 */
export type CompanionInboundFailure = {
  readonly id: string;
  readonly error: CompanionError;
  readonly close: boolean;
};

export const decodeCompanionRequestLine = (
  line: string,
): Result.Result<CompanionRequestFrame, CompanionInboundFailure> => {
  if (utf8Bytes(line) + 1 > COMPANION_MAX_INBOUND_BYTES) {
    return Result.fail({ id: "", error: companionError("too-large", COMPANION_ERROR_COPY["too-large"]), close: true });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return Result.fail({ id: "", error: companionError("invalid", "The frame was not JSON."), close: false });
  }
  const version = (raw as { v?: unknown } | null)?.v;
  const envelope = decodeEnvelope(raw);
  const id = Result.isSuccess(envelope) ? envelope.success.id : "";
  if (version !== COMPANION_PROTOCOL) {
    return Result.fail({
      id,
      error: companionError("unsupported-version", COMPANION_ERROR_COPY["unsupported-version"]),
      close: true,
    });
  }
  if (Result.isFailure(envelope)) {
    return Result.fail({ id: "", error: companionError("invalid", "The frame is not a request."), close: false });
  }
  if (!(COMPANION_OPS as ReadonlyArray<string>).includes(envelope.success.op)) {
    return Result.fail({ id, error: companionError("invalid", "Unknown operation."), close: false });
  }
  const frame = decodeRequestFrame({ ...(raw as object), args: envelope.success.args ?? {} });
  if (Result.isFailure(frame)) {
    // Never echo the parse issue: it can quote the submitted text.
    return Result.fail({ id, error: companionError("invalid", "The arguments were not valid."), close: false });
  }
  return Result.succeed(frame.success as CompanionRequestFrame);
};

/**
 * One Mac frame as a line. Validated against the schema so a handler can never
 * send the phone a shape the contract does not have; a frame over the limit
 * becomes an `internal` error for the same request instead.
 */
export const encodeCompanionFrame = (frame: CompanionOutboundFrame): string => {
  const encoded = encodeOutbound(frame);
  if (Result.isFailure(encoded)) {
    const id = "id" in frame ? frame.id : "";
    return `${JSON.stringify(companionFail(id, companionError("internal", COMPANION_ERROR_COPY.internal)))}\n`;
  }
  const line = `${JSON.stringify(encoded.success)}\n`;
  if (utf8Bytes(line) <= COMPANION_MAX_OUTBOUND_BYTES) return line;
  const id = "id" in frame ? frame.id : "";
  return `${JSON.stringify(companionFail(id, companionError("internal", "The reply was too large to send.")))}\n`;
};

/** For the phone side and tests: one Mac line, decoded. */
export const decodeCompanionOutboundLine = (
  line: string,
): Result.Result<CompanionOutboundFrame, string> => {
  try {
    const decoded = decodeOutbound(JSON.parse(line));
    return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail("not a companion frame");
  } catch {
    return Result.fail("not JSON");
  }
};

/** A connection-level error line (no request to answer). */
export const companionConnectionErrorLine = (code: CompanionErrorCode, message?: string): string =>
  encodeCompanionFrame({
    v: COMPANION_PROTOCOL,
    type: "response",
    id: "",
    ok: false,
    error: companionError(code, message ?? COMPANION_ERROR_COPY[code]),
  } as CompanionOutboundFrame);

// --- pairing -----------------------------------------------------------------

/** The QR payload, carried base64url in `junto-companion://pair?d=`. */
export const CompanionPairingPayload = Schema.Struct({
  v: V,
  deviceId: CompanionDeviceId,
  station: Schema.String,
  hosts: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
  port: intBetween(1, 65_535),
  user: bounded(1, 256),
  hostKey: bounded(1, 4_096),
  pairingKey: bounded(1, 8_192),
  expiresAt: Schema.Number,
});
export type CompanionPairingPayload = typeof CompanionPairingPayload.Type;

const base64url = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

export const companionPairingUrl = (payload: CompanionPairingPayload): string =>
  `junto-companion://pair?d=${base64url(JSON.stringify(payload))}`;

export const decodeCompanionPairingUrl = (
  url: string,
): Result.Result<CompanionPairingPayload, string> => {
  const prefix = "junto-companion://pair?d=";
  if (!url.startsWith(prefix)) return Result.fail("not a pairing link");
  try {
    const json = Buffer.from(url.slice(prefix.length).replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
    const decoded = Schema.decodeUnknownResult(CompanionPairingPayload)(JSON.parse(json));
    return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail("invalid pairing payload");
  } catch {
    return Result.fail("invalid pairing payload");
  }
};
