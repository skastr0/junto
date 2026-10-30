import { Schema, type Effect } from "effect";
import { EncodedCauses, EncodedFailure, failureSentence, type EncodedCause } from "@shared/failure";
import type { InstallationId } from "@shared/installation-id";
import { describeCause, causeChain } from "../failure-encode";

export type LinkChannel = "rows" | "seats" | "status" | "inventory" | "settings" | "native-config" | "content" | "consensus" | "authority";

export interface LinkHello {
  readonly build: string;
  readonly installationId: InstallationId;
  readonly machineName: string;
}

const HelloFields = Schema.Struct({ build: Schema.String, installationId: Schema.String, machineName: Schema.String });

/** Which hello check refused the peer. */
export const HelloCheck = Schema.Literals(["first-frame", "repeated", "decode", "self-link", "route-name", "setup-identity", "opener", "opener-key", "opener-key-required"]);
export type HelloCheck = typeof HelloCheck.Type;

export class LinkHelloRefused extends Schema.TaggedError<LinkHelloRefused>()("LinkHelloRefused", {
  machine: Schema.optionalKey(Schema.String),
  check: HelloCheck,
  message: Schema.String,
}) {}

/** A closed hello is available for diagnostics, but was never admitted. */
export class LinkBuildMismatch extends Schema.TaggedError<LinkBuildMismatch>()("LinkBuildMismatch", {
  machine: Schema.String,
  peer: HelloFields,
  localBuild: Schema.String,
  message: Schema.String,
}) {
  static of(peer: LinkHello, localBuild: string): LinkBuildMismatch {
    return new LinkBuildMismatch({ machine: peer.machineName, peer: { ...peer }, localBuild, message: `Update ${peer.machineName} before connecting Junto` });
  }
}

export class LinkPeerNotPinned extends Schema.TaggedError<LinkPeerNotPinned>()("LinkPeerNotPinned", {
  machine: Schema.String,
  installationId: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export const FrameProblem = Schema.Literals(["bytes", "utf8", "json", "schema", "frame-bound", "payload", "unmatched-response", "unknown-channel", "no-handler", "duplicate-request", "credit-unwindowed", "credit-excess"]);
export type FrameProblem = typeof FrameProblem.Type;

export class LinkFrameInvalid extends Schema.TaggedError<LinkFrameInvalid>()("LinkFrameInvalid", {
  machine: Schema.optionalKey(Schema.String),
  problem: FrameProblem,
  message: Schema.String,
}) {}

/** The peer answered a request with its own failure, decoded closed. */
export class LinkRequestFailed extends Schema.TaggedError<LinkRequestFailed>()("LinkRequestFailed", {
  machine: Schema.String,
  channel: Schema.String,
  operationId: Schema.String,
  failure: EncodedFailure,
  /** The channel's own typed failure, when its failureSchema decoded one. */
  detail: Schema.optionalKey(Schema.Unknown),
  message: Schema.String,
}) {}

/** Who ended the link: this end, the peer (with its reason), or the process under it. */
export const LinkClosedBy = Schema.Literals(["this-end", "peer", "process"]);
export type LinkClosedBy = typeof LinkClosedBy.Type;
export const LinkClosedReason = Schema.Literals([
  "closed", "shutting-down", "hello-timeout", "request-timeout", "credit-timeout", "refused", "frame-invalid",
  "bound-exceeded", "write-failed", "input-ended", "output-closed", "peer-closed", "process-exited", "failed", "superseded",
]);
export type LinkClosedReason = typeof LinkClosedReason.Type;

export class LinkClosed extends Schema.TaggedError<LinkClosed>()("LinkClosed", {
  machine: Schema.optionalKey(Schema.String),
  by: LinkClosedBy,
  reason: LinkClosedReason,
  exitCode: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  /** Scrubbed by the machine that read the bytes (StderrTail). */
  stderrTail: Schema.optionalKey(Schema.String),
  stderrCut: Schema.optionalKey(Schema.Literal(true)),
  /** The first cause last, as tag and scrubbed message pairs. */
  causes: EncodedCauses,
  message: Schema.String,
}) {}

/** The link cannot take this call: not linked, not configured, or shutting down. */
export const LinkUnavailableReason = Schema.Literals(["not-linked", "not-configured", "channels-bound", "unknown-channel", "listener-unavailable", "shutting-down", "route-incomplete", "other-installation", "invalid-limits", "not-admitted", "channel-unavailable", "request-from-event", "send-from-event", "send-queue-full", "asleep"]);
export class LinkUnavailable extends Schema.TaggedError<LinkUnavailable>()("LinkUnavailable", {
  machine: Schema.optionalKey(Schema.String),
  reason: LinkUnavailableReason,
  message: Schema.String,
}) {}

/** The closed set every link operation fails with. */
export type MachineLinkError = LinkHelloRefused | LinkBuildMismatch | LinkPeerNotPinned | LinkFrameInvalid | LinkRequestFailed | LinkClosed | LinkUnavailable;
const LINK_TAGS = new Set(["LinkHelloRefused", "LinkBuildMismatch", "LinkPeerNotPinned", "LinkFrameInvalid", "LinkRequestFailed", "LinkClosed", "LinkUnavailable"]);
export const isMachineLinkError = (cause: unknown): cause is MachineLinkError =>
  cause instanceof Error && LINK_TAGS.has((cause as { _tag?: unknown })._tag as string);

const BY_TEXT: Record<LinkClosedBy, string> = { "this-end": "this machine closed it", peer: "the other machine closed it", process: "its SSH process ended" };
const REASON_TEXT: Record<LinkClosedReason, string> = {
  closed: "closed on request", "shutting-down": "Junto is shutting down", "hello-timeout": "the hello did not arrive in time",
  "request-timeout": "a request timed out; its outcome is uncertain", "credit-timeout": "the other machine stopped taking events", refused: "the hello was refused", "frame-invalid": "a frame was invalid",
  "bound-exceeded": "a bound was exceeded", "write-failed": "a write failed", "input-ended": "its input ended",
  "output-closed": "its output closed", "peer-closed": "the other machine gave no reason", "process-exited": "the process ended", failed: "it failed",
  superseded: "the other link between these machines is kept",
};

/** A LinkClosed whose message says who closed and the first cause. */
export const linkClosed = (input: {
  readonly machine?: string;
  readonly by: LinkClosedBy;
  readonly reason: LinkClosedReason;
  readonly cause?: unknown;
  readonly causes?: ReadonlyArray<EncodedCause>;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stderrTail?: string;
  readonly stderrCut?: boolean;
}): LinkClosed => {
  const chain = input.causes ?? (input.cause === undefined ? [] : [describeCause(input.cause), ...causeChain(input.cause).causes]);
  const causes = chain.slice(0, 8);
  const exit = input.signal !== undefined ? `signal ${input.signal}` : input.exitCode !== undefined ? `exit code ${input.exitCode}` : undefined;
  const lastLine = input.stderrTail?.split("\n").map(line => line.trim()).filter(Boolean).at(-1);
  const said = causes.length === 0 ? "" : failureSentence({ message: causes[0]!.message, causes: causes.slice(1) });
  const why = [exit, lastLine, said === "" ? (exit === undefined && lastLine === undefined ? REASON_TEXT[input.reason] : undefined) : said].filter(Boolean).join(": ");
  return new LinkClosed({
    ...(input.machine === undefined ? {} : { machine: input.machine }),
    by: input.by,
    reason: input.reason,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.stderrTail === undefined || input.stderrTail === "" ? {} : { stderrTail: input.stderrTail }),
    ...(input.stderrCut === true ? { stderrCut: true as const } : {}),
    causes,
    message: `The link${input.machine === undefined ? "" : ` to ${input.machine}`} closed, ${BY_TEXT[input.by]}${why === "" ? "" : `: ${why}`}`,
  });
};

/** Identity comes only from an admitted hello, never from a channel payload. */
export interface LinkChannelContext {
  readonly peer: LinkHello;
  /**
   * The peer is proven by its link key: this end accepted it through the
   * relay's opener, or dialed it over a bound route. Fleet consensus admits
   * nothing else.
   */
  readonly keyBound: boolean;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  /** The operation the current request belongs to; absent outside a request. */
  readonly operationId?: string;
  readonly sendEvent: (channel: LinkChannel, payload: unknown) => Effect.Effect<void, MachineLinkError>;
  readonly request: (channel: LinkChannel, payload: unknown, operationId?: string) => Effect.Effect<unknown, MachineLinkError>;
  /** Closes the link with a typed cause, logged at both ends and sent to the peer. */
  readonly close: (cause: unknown) => Effect.Effect<void>;
}

/**
 * What an event handler gets: no request. The session may stop reading while
 * events back up, and a handler awaiting an answer on its own link would wait
 * on a reader that waits on it. The session also refuses one at run time, and
 * refuses a send on a windowed channel that would wait for the peer's credit
 * while the hook or handler runs. A fiber it leaves behind may wait, so a
 * handler never calls such a fiber's send inline: only the fiber sends.
 */
export type LinkEventContext = Omit<LinkChannelContext, "request">;

/**
 * Each decoder must reject excess fields and throw on invalid input. The
 * session calls it before dispatch, pending-response resolution or event use.
 * A channel without requests or events supplies a decoder that rejects them.
 */
export interface LinkChannelHandler {
  readonly decodeRequest: (payload: unknown) => unknown;
  readonly decodeResponse: (payload: unknown) => unknown;
  readonly decodeEvent: (payload: unknown) => unknown;
  /**
   * The channel's closed failure union. A handler failure that encodes under
   * it crosses as `detail`, and the requester decodes it with the same schema.
   */
  readonly failureSchema?: Schema.Codec<unknown, unknown>;
  readonly handleRequest?: (context: LinkChannelContext, payload: unknown) => Effect.Effect<unknown, unknown>;
  readonly handleEvent?: (context: LinkEventContext, payload: unknown) => Effect.Effect<void, unknown>;
  /** Runs in the channel's event queue, so it gets no request either. */
  readonly opened?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
  readonly closed?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
}

export type LinkChannels = Readonly<Partial<Record<LinkChannel, LinkChannelHandler>>>;

/** The identical session interface over a socket or an SSH duplex stream. */
export interface LinkSession {
  readonly sessionId: string;
  readonly ready: Promise<LinkHello>;
  readonly closed: Promise<LinkClosed>;
  readonly request: (channel: LinkChannel, payload: unknown, operationId?: string) => Promise<unknown>;
  readonly sendEvent: (channel: LinkChannel, payload: unknown) => Promise<void>;
  /** Closes with a typed cause; without one, a deliberate close by this end. */
  readonly close: (cause?: unknown) => Promise<void>;
}
