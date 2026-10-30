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
 * A wire module: its import closure is `effect` alone (a test holds it), so
 * the mobile repo copies it verbatim. No Node or DOM globals either.
 *
 * Decoding is lenient about unknown fields (the protocol is additive-only:
 * a newer phone may send an optional argument this build does not know yet)
 * and strict about everything it does know. Frame size is bounded in both
 * directions before any JSON is parsed or written.
 */

import { Result, Schema } from "effect";
import { AgentSignal, AgentSignalKind, type SignalSource } from "./agent-signals";
import {
  CompanionArtifactChanged,
  CompanionArtifactsSubscribeArgs,
  CompanionCommentsChanged,
  CompanionCommentsListArgs,
  CompanionCommentsListData,
  CompanionCommentPostArgs,
  CompanionCommentPostData,
  CompanionMentionCandidatesArgs,
  CompanionMentionCandidatesData,
  CompanionMentionLinkedFromArgs,
  CompanionMentionLinkedFromData,
  CompanionMentionResolveArgs,
  CompanionMentionResolveData,
} from "./companion-artifacts";
import { ContentDisplayName, ContentMediaType, ContentRef, ContentSha256 } from "./content-ref";
import {
  CompanionArtifactGetArgs,
  CompanionArtifactHistoryArgs,
  CompanionArtifactHistoryResult,
  CompanionArtifactMoveCheckArgs,
  CompanionArtifactMoveCheckResult,
  CompanionArtifactPendingArgs,
  CompanionArtifactPendingResult,
  CompanionArtifactGetResult,
  CompanionArtifactsListArgs,
  CompanionArtifactsListResult,
  CompanionArtifactsNodesArgs,
  CompanionArtifactsNodesResult,
  CompanionInboxSetArgs,
  CompanionInboxSetResult,
} from "./companion-artifact-reads";
export type { CompanionArtifactChanged } from "./companion-artifacts";
import {
  CompanionArtifactApplyArgs,
  CompanionArtifactApplyResult,
  COMPANION_ARTIFACT_CONFLICT_FIELDS,
  CompanionContentStagePurpose,
  CompanionSignalArtifactAnswer,
} from "./companion-artifact-writes";
import { FeedHealth, FeedRegion, OperatorFeed } from "./operator-feed";
import { RingState } from "./rings";
import { ResourceSubject } from "./thread-subject";
import { UrgencyLevel } from "./urgency";

export const COMPANION_PROTOCOL = "junto-companion/1" as const;

/**
 * Phone to Mac. A larger frame is `too-large` and the channel closes. Sized for
 * one `content.stage` piece; every other op keeps COMPANION_MAX_REQUEST_BYTES.
 */
export const COMPANION_MAX_INBOUND_BYTES = 288 * 1024;
/** Phone to Mac, any op but `content.stage`. A larger frame is `too-large` and the channel closes. */
export const COMPANION_MAX_REQUEST_BYTES = 16 * 1024;
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
/** Bytes one `content.get` returns at most: as base64 it stays under the outbound frame. */
export const COMPANION_CONTENT_CHUNK_MAX = 256 * 1024;
/** Raw bytes one `content.stage` piece carries at most: as base64 it stays under the inbound frame. */
export const COMPANION_STAGE_CHUNK_MAX = 192 * 1024;
/** Files one operator mail or answer carries at most. */
export const COMPANION_ATTACHMENTS_MAX = 10;
/** Bytes one attached file holds at most. */
export const COMPANION_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Image types the desktop and the phone draw as a thumbnail; any other file is a chip. */
export const COMPANION_THUMBNAIL_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"] as const;
/** `content.get` requests one phone may have unanswered at once. */
export const COMPANION_CONTENT_IN_FLIGHT_MAX = 4;
/** Log rows one `machine.get` returns at most, the newest that match. */
export const COMPANION_MACHINE_LOG_ROWS = 50;
/** `machine.get` requests one phone may have unanswered at once: each can cross a link. */
export const COMPANION_MACHINE_IN_FLIGHT_MAX = 2;
/** A log row's or a failure's sentence, cut to this many characters for the phone. */
export const COMPANION_MACHINE_TEXT_MAX = 1024;
/** A check older than this is not sent: the phone shows the machine as not checked. */
export const COMPANION_MACHINE_CHECK_AGO_MAX_MS = 7 * 24 * 60 * 60_000;
/** Waypoints one drawn wire carries at most. */
export const COMPANION_WIRE_POINTS_MAX = 256;
/** How round a drawn wire's corners are, canvas units: the desktop's. */
export const COMPANION_WIRE_RADIUS = 8;

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
/** A mail id a phone sends: a ULID. */
const MailId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/u)));
/** A mail id as the Mac answers it: a ULID, or an older row's longer id. */
const MailRef = bounded(1, 128);

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
  /** The ring the desktop draws for the seat now (ringState), so the phone draws the same one. */
  ring: Schema.optionalKey(RingState),
  /** When that ring began, ms on the Mac's clock: a done ring lands from here. */
  stateStartedAt: Schema.optionalKey(Schema.Number),
  /** The seat's level on the urgency ladder (seatLevel): the desktop palette's order reads it. */
  level: Schema.optionalKey(UrgencyLevel),
  /** When the seat took that level, ms on the Mac's clock: the palette's tie rule within a group. */
  levelSince: Schema.optionalKey(Schema.Number),
  /**
   * What the operator has not read in the seat's threads, the desktop badge's
   * number. Absent when the Mac could not read it, and from an older Mac.
   */
  unread: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CompanionSeat = typeof CompanionSeat.Type;

/** A short live note about what the seat is doing. Ephemeral: gone after `expiresAt`. */
export const CompanionPreamble = Schema.Struct({
  preambleId: Schema.String,
  text: Schema.String,
  source: Schema.Literals(["agent", "ai", "junto", "operator"]),
  at: Schema.Number,
  expiresAt: Schema.Number,
});
export type CompanionPreamble = typeof CompanionPreamble.Type;

/** One line of the seat sidebar's Activity list, in the desktop's words. */
export const CompanionActivity = Schema.Struct({
  at: Schema.Number,
  label: Schema.String,
  kind: Schema.Literals(["mail", "signal", "state", "work", "other"]),
  targetName: Schema.optionalKey(Schema.String),
});
export type CompanionActivity = typeof CompanionActivity.Type;

/** The seat plus what its detail screen shows. Lists are newest first. */
export const CompanionSeatDetail = Schema.Struct({
  ...CompanionSeat.fields,
  /** The seat's region briefing, markdown, when it has one. */
  briefing: Schema.optionalKey(Schema.String),
  /** Only the ones still live. */
  preambles: Schema.Array(CompanionPreamble),
  /** Every state, last 50. */
  signals: Schema.Array(AgentSignal),
  /** Last 50. */
  activity: Schema.Array(CompanionActivity),
  /** Agent seats wired to this one: who a mail may mention. A hint; the Mac checks. */
  connected: Schema.optionalKey(
    Schema.Array(Schema.Struct({ nodeId: NodeId, name: bounded(0, 256) })).pipe(Schema.check(Schema.isMaxLength(64))),
  ),
});
export type CompanionSeatDetail = typeof CompanionSeatDetail.Type;

/** How many signals and activity lines a seat detail carries. */
export const COMPANION_SEAT_HISTORY_LIMIT = 50;

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
  /** The thread it is in: the root mail's id, its own when it starts one. */
  threadId: Schema.optionalKey(MailRef),
  inReplyTo: Schema.optionalKey(MailRef),
  /** Files the mail carries; `content.get` serves their bytes. */
  attachments: Schema.optionalKey(Schema.Array(ContentRef)),
});
export type CompanionMail = typeof CompanionMail.Type;

// --- threads -----------------------------------------------------------------
// The desktop's own derivation (src/shared/mail-threads.ts), bounded for the
// phone. Bodies, titles and names are the operator's content: plain text on
// the phone, never scrubbed and never rendered as anything else.

/** Threads one `threads.list` carries at most: those the operator is in first, then those between seats, newest activity first in each. */
export const COMPANION_THREADS_MAX = 200;
/** Messages one `thread.get` carries at most, newest kept. */
export const COMPANION_THREAD_MESSAGES_MAX = 200;
/** A page cursor, opaque to the phone: it hands back what the Mac gave it. */
const ThreadCursor = bounded(1, 256);
const ThreadPageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COMPANION_THREADS_MAX }));
/** A summary's last mail is a preview this long. */
export const COMPANION_THREAD_PREVIEW_MAX = 280;
/** One mail's text, cut to this for the phone. */
export const COMPANION_THREAD_TEXT_MAX = 32_000;
/** Seats one mail may mention. */
export const COMPANION_MENTIONS_MAX = 32;

const ThreadSeat = Schema.Struct({ kind: Schema.Literal("seat"), nodeId: NodeId, name: bounded(0, 256) });
export const CompanionThreadParty = Schema.Union([Schema.Struct({ kind: Schema.Literal("operator") }), ThreadSeat]);
export type CompanionThreadParty = typeof CompanionThreadParty.Type;

export const CompanionThreadMessage = Schema.Struct({
  messageId: MailRef,
  threadId: MailRef,
  inReplyTo: Schema.optionalKey(MailRef),
  from: CompanionThreadParty,
  to: Schema.Array(CompanionThreadParty).pipe(Schema.check(Schema.isMaxLength(32))),
  /** The operator wrote it. */
  mine: Schema.Boolean,
  text: Schema.String.pipe(Schema.check(Schema.isMaxLength(COMPANION_THREAD_TEXT_MAX))),
  /** The text was cut to its bound: a summary's preview, or a very long mail. */
  textCut: Schema.optionalKey(Schema.Literal(true)),
  at: Schema.Number,
  /** Files the mail carries; `content.get` serves their bytes. */
  attachments: Schema.optionalKey(Schema.Array(ContentRef)),
  /** The resource the thread is about; absent for a seat's mailbox thread. */
  subject: Schema.optionalKey(ResourceSubject),
});
export type CompanionThreadMessage = typeof CompanionThreadMessage.Type;

export const CompanionThreadSummary = Schema.Struct({
  threadId: MailRef,
  title: Schema.String.pipe(Schema.check(Schema.isMaxLength(COMPANION_THREAD_PREVIEW_MAX))),
  participants: Schema.Array(CompanionThreadParty).pipe(Schema.check(Schema.isMaxLength(64))),
  startedAt: Schema.Number,
  lastAt: Schema.Number,
  /** Its text is a preview of at most 280 characters. */
  last: CompanionThreadMessage,
  messageCount: Schema.Number,
  /** The operator wrote in it, or mail in it is addressed to the operator. */
  canReply: Schema.Boolean,
  /** The operator wrote at least one mail in it. This Mac always sends it; an older one does not. */
  owned: Schema.optionalKey(Schema.Boolean),
  /** The operator's last explicit mark, on the Mac's clock; writing does not move it. Absent when never marked, and from an older Mac. */
  readAt: Schema.optionalKey(Schema.Number),
  /** Replies to the operator past their read, in a thread they are in; 0 for a thread between seats. This Mac always sends it. */
  unread: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The resource the thread is about; absent for a seat's mailbox thread. */
  subject: Schema.optionalKey(ResourceSubject),
});
export type CompanionThreadSummary = typeof CompanionThreadSummary.Type;

// --- canvas --------------------------------------------------------------------
// What the desktop draws, read only, through a whitelist: each node's kind,
// rectangle, paint order, title and colour, and each wire's ends and drawn
// route. No other node field crosses: not a region's environment, briefing or
// contract, nor a seat's agent, host, binding or launch.

/** The desktop's node kinds; a region is a node like any other. */
export const COMPANION_CANVAS_NODE_KINDS = [
  "agent",
  "peer",
  "terminal",
  "page",
  "task",
  "artifacts",
  "automations",
  "files",
  "note",
  "label",
  "file",
  "link",
  "git",
  "region",
] as const;
export const CompanionCanvasNodeKind = Schema.Literals(COMPANION_CANVAS_NODE_KINDS);
export type CompanionCanvasNodeKind = typeof CompanionCanvasNodeKind.Type;

const CanvasLength = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)));

export const CompanionCanvasPoint = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export type CompanionCanvasPoint = typeof CompanionCanvasPoint.Type;

export const CompanionCanvasNode = Schema.Struct({
  /** For a seat, CompanionSeat.nodeId: a tap opens that seat. */
  nodeId: NodeId,
  kind: CompanionCanvasNodeKind,
  /** Canvas units, as the desktop places it. */
  frame: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: CanvasLength, height: CanvasLength }),
  /** Paint order, lowest first; only the order matters. */
  z: Schema.Number.pipe(Schema.check(Schema.isInt())),
  /** The title the desktop's card shows. */
  label: Schema.optionalKey(bounded(1, 256)),
  /** The desktop's colour: a preset "1" to "6" or a hex. */
  color: Schema.optionalKey(bounded(1, 64)),
});
export type CompanionCanvasNode = typeof CompanionCanvasNode.Type;

export const CompanionCanvasWire = Schema.Struct({
  wireId: bounded(1, 256),
  from: NodeId,
  to: NodeId,
  /** The route the desktop draws, as waypoints in canvas units, start to end. */
  path: Schema.Array(CompanionCanvasPoint).pipe(
    Schema.check(Schema.isMinLength(2)),
    Schema.check(Schema.isMaxLength(COMPANION_WIRE_POINTS_MAX)),
  ),
  /** How round its corners are, canvas units. */
  radius: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CompanionCanvasWire = typeof CompanionCanvasWire.Type;

/** The whole scene `canvas.open` answers. */
export const CompanionCanvasScene = Schema.Struct({
  seq: Schema.Number.pipe(Schema.check(Schema.isInt())),
  nodes: Schema.Array(CompanionCanvasNode),
  wires: Schema.Array(CompanionCanvasWire),
});
export type CompanionCanvasScene = typeof CompanionCanvasScene.Type;

// --- machines ----------------------------------------------------------------
// Read only. No endpoint, path, key, pin or installation id reaches the phone.

/** A typed failure as the phone shows it: its tag and its scrubbed sentence, no cause chain. */
export const CompanionMachineFailure = Schema.Struct({
  tag: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u))),
  message: bounded(1, COMPANION_MACHINE_TEXT_MAX),
});
export type CompanionMachineFailure = typeof CompanionMachineFailure.Type;

export const CompanionMachine = Schema.Struct({
  name: bounded(1, 64),
  label: bounded(1, 64),
  thisMachine: Schema.Boolean,
  form: Schema.optionalKey(Schema.Literals(["macbook", "mac-mini", "mac-studio", "mac", "linux"])),
  setUp: Schema.Boolean,
  /** Its build differs from this Mac's, as the owner compares them. */
  needsUpdate: Schema.Boolean,
  /** The matching tailnet device's own flag: not Junto reachability. */
  tailnet: Schema.Literals(["online", "offline", "unknown"]),
  /** The newest `machine.get` answer for it. A duration, never a time: the phone ages it on its own clock. */
  lastCheck: Schema.optionalKey(Schema.Struct({
    checkedAgoMs: intBetween(0, COMPANION_MACHINE_CHECK_AGO_MAX_MS),
    reachable: Schema.Boolean,
    failure: Schema.optionalKey(CompanionMachineFailure),
  })),
});
export type CompanionMachine = typeof CompanionMachine.Type;

export const CompanionMachineLogLevel = Schema.Literals(["trace", "debug", "info", "warn", "error", "fatal"]);
export type CompanionMachineLogLevel = typeof CompanionMachineLogLevel.Type;

export const CompanionMachineStatus = Schema.Struct({
  reachable: Schema.Boolean,
  /** The first 12 hex of its build, for display. */
  build: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{12}$/u)))),
  keychain: Schema.optionalKey(Schema.Literals(["available", "unavailable", "not-applicable"])),
  harnesses: Schema.Array(Schema.Struct({
    harness: bounded(1, 64),
    installed: Schema.Boolean,
    signIn: Schema.optionalKey(Schema.Literals(["not-installed", "sign-in-unverified", "keychain-login-unavailable"])),
  })).pipe(Schema.check(Schema.isMaxLength(32))),
  /** Names only, never values. */
  missingSecrets: Schema.Array(Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)))).pipe(
    Schema.check(Schema.isMaxLength(64)),
  ),
  detail: Schema.optionalKey(bounded(1, 1024)),
  failure: Schema.optionalKey(CompanionMachineFailure),
});
export type CompanionMachineStatus = typeof CompanionMachineStatus.Type;

export const CompanionMachineLogRow = Schema.Struct({
  time: bounded(1, 32),
  level: CompanionMachineLogLevel,
  area: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,47}$/u))),
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(COMPANION_MACHINE_TEXT_MAX))),
  canvas: Schema.optionalKey(bounded(1, 256)),
  seat: Schema.optionalKey(bounded(1, 128)),
  failure: Schema.optionalKey(CompanionMachineFailure),
});
export type CompanionMachineLogRow = typeof CompanionMachineLogRow.Type;

export const CompanionMachineLogs = Schema.Union([
  Schema.Struct({
    /** The newest rows that match, oldest first. */
    rows: Schema.Array(CompanionMachineLogRow).pipe(Schema.check(Schema.isMaxLength(COMPANION_MACHINE_LOG_ROWS))),
    /** More rows matched than were returned. */
    cut: Schema.Boolean,
  }),
  /** The log could not be read: a fixed sentence saying why, never the raw link error. */
  Schema.Struct({ unavailable: bounded(1, 256) }),
]);
export type CompanionMachineLogs = typeof CompanionMachineLogs.Type;

/** Outside text, chosen by whoever runs that device: plain text only on the phone. */
export const CompanionTailnetPeer = Schema.Struct({
  name: bounded(1, 64),
  dnsName: Schema.optionalKey(bounded(1, 255)),
  os: Schema.optionalKey(bounded(1, 32)),
  online: Schema.Boolean,
  /** The Junto machine this device is, when it is one. */
  machine: Schema.optionalKey(bounded(1, 64)),
});
export type CompanionTailnetPeer = typeof CompanionTailnetPeer.Type;

/** Addresses one hello may carry, the pairing QR's list. */
export const COMPANION_HELLO_HOSTS_MAX = 8;
/**
 * A host name, an IPv4 address, or a bracket-free IPv6 address with an
 * optional zone: no leading "-", whitespace, "@" or "/", so no value can be
 * read as an SSH option or a user@ prefix by any client.
 */
export const COMPANION_HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f:]+(?:%[A-Za-z0-9]+)?)$/u;
export const isCompanionHost = (host: string): boolean => host.length <= 253 && COMPANION_HOST_PATTERN.test(host);

/**
 * What this Mac answers beyond the base ops, named `<feature>/<n>`. The phone
 * shows a surface only when its feature is here, so an older Mac is never sent
 * an op it refuses. A feature's ops are added in the same change that names it.
 *
 * `threads/2` is the threads a page at a time: `limit` and `after` on
 * `threads.list`, `limit` and `before` on `thread.get`, `threads.read`, and
 * the read state (`unread`, `readAt`, `thread.changed`). A 0.11.0 Mac refuses
 * a page's keys as invalid and `threads.read` as unknown, so without it the
 * phone sends the bare `{canvasName, nodeId}`.
 */
export const COMPANION_FEATURES = ["artifacts/1", "threads/2"] as const;
export const COMPANION_FEATURES_MAX = 16;

export const CompanionHello = Schema.Struct({
  appVersion: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
  station: Schema.String,
  serverTime: Schema.Number,
  /**
   * Where this Mac answers now, in the pairing QR's order (MagicDNS name
   * first). The phone merges it in: the new list first, then the stored
   * entries it lacks, the paired MagicDNS name always kept; absent, it keeps
   * its own. Never the host key: a changed key still needs the operator.
   */
  hosts: Schema.optionalKey(
    Schema.Array(bounded(1, 253).pipe(Schema.check(Schema.isPattern(COMPANION_HOST_PATTERN)))).pipe(
      Schema.check(Schema.isMaxLength(COMPANION_HELLO_HOSTS_MAX)),
    ),
  ),
  /** The features this Mac serves (`COMPANION_FEATURES`); absent on a Mac that predates them. */
  features: Schema.optionalKey(
    Schema.Array(bounded(1, 32).pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]*\/[0-9]+$/)))).pipe(
      Schema.check(Schema.isMaxLength(COMPANION_FEATURES_MAX)),
    ),
  ),
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
  "seat.get",
  "signal.answer",
  "signal.dismiss",
  "mail.list",
  "mail.send",
  "quickReplies.get",
  "portrait.get",
  "content.get",
  "content.stage",
  "machines.list",
  "machine.get",
  "tailnet.peers",
  "artifact.history",
  "artifact.moveCheck",
  "artifact.pending",
  "artifact.get",
  "artifacts.list",
  "artifacts.nodes",
  "inbox.set",
  "artifact.apply",
  "threads.list",
  "thread.get",
  "threads.read",
  "canvas.open",
  "canvas.close",
  /** A subject's comments, read and written; comments.changed while a list is open on it. */
  "comments.list",
  "comment.post",
  "mentions.candidates",
  "mentions.resolve",
  "mentions.linkedFrom",
  /** One canvas's artifact changes, and the events that follow. */
  "artifacts.subscribe",
  "artifacts.unsubscribe",
] as const;
export const CompanionOpName = Schema.Literals(COMPANION_OPS);
export type CompanionOpName = typeof CompanionOpName.Type;

/** Ops that change something; these count against the write limit. */
export const COMPANION_WRITE_OPS: ReadonlySet<CompanionOpName> = new Set([
  "signal.answer",
  "signal.dismiss",
  "mail.send",
  "inbox.set",
  "comment.post",
]);

const Empty = Schema.Struct({});

/** Files the operator staged first, named by the ref `content.stage` answered. Only sha256 and byteLength are read. */
const Attachments = Schema.Array(ContentRef).pipe(Schema.check(Schema.isMaxLength(COMPANION_ATTACHMENTS_MAX)));

/** Text, or files, or both: a send with neither is `invalid`. */
const textOrFiles = Schema.makeFilter(
  ({ text, attachments }: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> }) =>
    text.length > 0 || (attachments?.length ?? 0) > 0 || "a send carries text, files, or both",
);

const SafeOffset = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
);

export const CompanionArgs = {
  "pair.complete": Schema.Struct({ publicKey: CompanionPublicKey, deviceName: CompanionDeviceName }),
  ping: Empty,
  "canvases.list": Empty,
  "feed.get": Schema.Struct({ canvasName: Schema.optionalKey(CanvasName) }),
  "feed.subscribe": Schema.Struct({ canvasName: Schema.optionalKey(CanvasName) }),
  "feed.unsubscribe": Empty,
  "seats.list": Schema.Struct({ canvasName: CanvasName }),
  "seat.get": Schema.Struct({ canvasName: CanvasName, nodeId: NodeId }),
  // A quiet answer is recorded on the signal with no mail, so the seat is not
  // woken; its text may be empty (an acknowledgement). The quiet form decodes
  // first: the loud form would drop an unknown `quiet` and send mail.
  "signal.answer": Schema.Union([
    Schema.Struct({
      signalId: bounded(1, 128),
      text: bounded(0, COMPANION_MAX_TEXT),
      quiet: Schema.Literal(true),
      attachments: Schema.optionalKey(Attachments),
    }),
    Schema.Struct({
      signalId: bounded(1, 128),
      text: bounded(0, COMPANION_MAX_TEXT),
      attachments: Schema.optionalKey(Attachments),
    }).pipe(Schema.check(textOrFiles)),
    CompanionSignalArtifactAnswer,
  ]),
  "signal.dismiss": Schema.Struct({ signalId: bounded(1, 128) }),
  "mail.list": Schema.Struct({
    canvasName: CanvasName,
    nodeId: NodeId,
    limit: Schema.optionalKey(intBetween(1, COMPANION_MAIL_MAX_LIMIT)),
  }),
  /**
   * With neither id, a new thread to the seat; `inReplyTo`, a reply in that
   * mail's thread; `threadId` alone, a mail into that thread. The mail goes
   * to this seat and no one else; a mention is the link in its text.
   * `mentions` is read from a phone that still sends it and kept nowhere.
   */
  "mail.send": Schema.Struct({
    canvasName: CanvasName,
    nodeId: NodeId,
    text: bounded(0, COMPANION_MAX_TEXT),
    threadId: Schema.optionalKey(MailId),
    inReplyTo: Schema.optionalKey(MailId),
    mentions: Schema.optionalKey(Schema.Array(NodeId).pipe(Schema.check(Schema.isMaxLength(COMPANION_MENTIONS_MAX)))),
    attachments: Schema.optionalKey(Attachments),
  }).pipe(Schema.check(textOrFiles)),
  "quickReplies.get": Empty,
  "portrait.get": Schema.Struct({
    portraitIdentity: bounded(1, 256),
    size: intBetween(16, 1024),
    theme: Schema.Literals(["bright", "dark"]),
    /** svg when absent; png is size x size pixels, so a native view never parses SVG. */
    format: Schema.optionalKey(Schema.Literals(["svg", "png"])),
  }),
  "content.get": Schema.Struct({
    sha256: ContentSha256,
    offset: SafeOffset,
    length: intBetween(1, COMPANION_CONTENT_CHUNK_MAX),
  }),
  /**
   * One piece of a file on its way into the Mac content store, for a mail or
   * an answer on `canvasName`. Offset 0 starts (or starts over) the upload of
   * that sha256 and byteLength; each later piece starts where the last ended.
   */
  "content.stage": Schema.Struct({
    canvasName: CanvasName,
    sha256: ContentSha256,
    byteLength: intBetween(1, COMPANION_ATTACHMENT_MAX_BYTES),
    mediaType: ContentMediaType,
    displayName: Schema.optionalKey(ContentDisplayName),
    /** What the bytes are for; absent, a mail or answer attachment claims them. */
    purpose: Schema.optionalKey(CompanionContentStagePurpose),
    offset: SafeOffset,
    /** Standard padded base64 of 1 to COMPANION_STAGE_CHUNK_MAX bytes. */
    data: bounded(4, Math.ceil(COMPANION_STAGE_CHUNK_MAX / 3) * 4),
  }),
  "machines.list": Empty,
  /** `minLevel`: only log rows at or above it, so noise never pushes an error off the page. */
  "machine.get": Schema.Struct({ name: bounded(1, 64), minLevel: Schema.optionalKey(CompanionMachineLogLevel) }),
  "tailnet.peers": Empty,
  /** `after` is the `next` of the page before; absent, the list starts at the top. */
  "threads.list": Schema.Struct({
    canvasName: CanvasName,
    nodeId: NodeId,
    limit: Schema.optionalKey(ThreadPageLimit),
    after: Schema.optionalKey(ThreadCursor),
  }),
  /** `before` is the `older` of the page after; absent, the newest page. */
  "thread.get": Schema.Struct({
    canvasName: CanvasName,
    nodeId: NodeId,
    threadId: MailId,
    limit: Schema.optionalKey(ThreadPageLimit),
    before: Schema.optionalKey(ThreadCursor),
  }),
  /**
   * The operator read a seat's thread through `through`, or through its
   * newest mail: one read point per thread, shared with the desktop and
   * every seat the thread is between. Only moves forward; idempotent.
   */
  "threads.read": Schema.Struct({ canvasName: CanvasName, nodeId: NodeId, threadId: MailId, through: Schema.optionalKey(MailId) }),
  /** The scene, and canvas.changed for it from then on; replaces any canvas this connection had open. */
  "canvas.open": Schema.Struct({ canvasName: CanvasName }),
  "canvas.close": Schema.Struct({ canvasName: CanvasName }),
  "artifact.history": CompanionArtifactHistoryArgs,
  "artifact.moveCheck": CompanionArtifactMoveCheckArgs,
  "artifact.pending": CompanionArtifactPendingArgs,
  "artifact.apply": CompanionArtifactApplyArgs,
  "artifact.get": CompanionArtifactGetArgs,
  "artifacts.list": CompanionArtifactsListArgs,
  "artifacts.nodes": CompanionArtifactsNodesArgs,
  "inbox.set": CompanionInboxSetArgs,
  "comments.list": CompanionCommentsListArgs,
  "comment.post": CompanionCommentPostArgs,
  "mentions.candidates": CompanionMentionCandidatesArgs,
  "mentions.resolve": CompanionMentionResolveArgs,
  "mentions.linkedFrom": CompanionMentionLinkedFromArgs,
  "artifacts.subscribe": CompanionArtifactsSubscribeArgs,
  "artifacts.unsubscribe": Empty,
} as const satisfies Record<CompanionOpName, Schema.Top>;

/**
 * Ops whose arguments are closed: any key the schema does not name is
 * `invalid`. Decoded with the option passed explicitly, never left to an
 * annotation, whose reach on a nested struct differs between Effect builds.
 */
export const COMPANION_CLOSED_ARGS_OPS: ReadonlySet<CompanionOpName> = new Set([
  "content.get",
  "content.stage",
  "mail.send",
  "threads.list",
  "artifact.history",
  "artifact.moveCheck",
  "artifact.pending",
  "artifact.get",
  "artifact.apply",
  "artifacts.list",
  "artifacts.nodes",
  "inbox.set",
  "thread.get",
  "threads.read",
  "canvas.open",
  "canvas.close",
  "comments.list",
  "comment.post",
  "mentions.candidates",
  "mentions.resolve",
  "mentions.linkedFrom",
  "artifacts.subscribe",
  "artifacts.unsubscribe",
]);

export type CompanionArgsByOp = { readonly [Op in CompanionOpName]: (typeof CompanionArgs)[Op]["Type"] };

export const CompanionResults = {
  "pair.complete": Schema.Struct({ deviceId: Schema.String }),
  ping: Schema.Struct({ serverTime: Schema.Number }),
  "canvases.list": Schema.Struct({ canvases: Schema.Array(CompanionCanvas) }),
  "feed.get": Schema.Struct({ feeds: Schema.Array(OperatorFeed) }),
  "feed.subscribe": Schema.Struct({ feeds: Schema.Array(OperatorFeed) }),
  "feed.unsubscribe": Empty,
  "seats.list": Schema.Struct({ seats: Schema.Array(CompanionSeat) }),
  "seat.get": Schema.Struct({ seat: CompanionSeatDetail }),
  "signal.answer": Schema.Struct({ signal: AgentSignal }),
  "signal.dismiss": Schema.Struct({ signal: AgentSignal }),
  "mail.list": Schema.Struct({ messages: Schema.Array(CompanionMail) }),
  "mail.send": Schema.Struct({ message: CompanionMail }),
  "quickReplies.get": Schema.Struct({
    replies: Schema.Array(Schema.String),
    /** The operator's quiet notes. Present: this Mac takes `signal.answer` with `quiet`. */
    quietNotes: Schema.optionalKey(Schema.Array(Schema.String)),
    /**
     * Present: this Mac takes `content.stage` and `attachments` on `mail.send`
     * and `signal.answer`. Absent, attach nothing: an older Mac drops the key
     * and the file would vanish.
     */
    attachments: Schema.optionalKey(
      Schema.Struct({
        maxCount: Schema.Number,
        maxBytes: Schema.Number,
        chunkBytes: Schema.Number,
        thumbnailTypes: Schema.Array(Schema.String),
      }),
    ),
  }),
  "portrait.get": Schema.Union([
    Schema.Struct({ svg: Schema.String }),
    /** Standard padded base64 of the PNG. */
    Schema.Struct({ png: Schema.String }),
  ]),
  "content.get": Schema.Struct({
    sha256: Schema.String,
    offset: Schema.Number,
    /** Bytes returned: fewer than asked only at the end of the file. */
    length: Schema.Number,
    /** The whole file's size, the same as its ref's. */
    byteLength: Schema.Number,
    /** Standard padded base64 of the bytes [offset, offset + length). */
    data: Schema.String,
  }),
  "content.stage": Schema.Union([
    /** Bytes the Mac holds so far: the next piece starts here. */
    Schema.Struct({ received: Schema.Number }),
    /** The last piece landed and the bytes hashed to what was named: attach this. */
    Schema.Struct({ ref: ContentRef }),
  ]),
  "machines.list": Schema.Struct({
    machines: Schema.Array(CompanionMachine).pipe(Schema.check(Schema.isMaxLength(32))),
  }),
  "machine.get": Schema.Struct({ machine: CompanionMachine, status: CompanionMachineStatus, logs: CompanionMachineLogs }),
  "tailnet.peers": Schema.Struct({
    /** False when Tailscale is absent or could not be read; never an error. */
    available: Schema.Boolean,
    peers: Schema.Array(CompanionTailnetPeer).pipe(Schema.check(Schema.isMaxLength(128))),
  }),
  "threads.list": Schema.Struct({
    threads: Schema.Array(CompanionThreadSummary).pipe(Schema.check(Schema.isMaxLength(COMPANION_THREADS_MAX))),
    /** The cursor for the page that follows; absent at the end. */
    next: Schema.optionalKey(ThreadCursor),
    /** Threads the page would have held were left out to fit; `next` resumes after the last one sent. */
    cut: Schema.Boolean,
  }),
  "thread.get": Schema.Struct({
    /** Oldest first; the oldest are left out first to fit. */
    messages: Schema.Array(CompanionThreadMessage).pipe(Schema.check(Schema.isMaxLength(COMPANION_THREAD_MESSAGES_MAX))),
    /** The cursor for the page above, older mail; absent at the thread's start. */
    older: Schema.optionalKey(ThreadCursor),
    /** Older messages the page would have held were left out to fit; `older` resumes above the first one sent. */
    cut: Schema.Boolean,
  }),
  /** The thread as it stands after the read. */
  "threads.read": Schema.Struct({ thread: CompanionThreadSummary }),
  "canvas.open": CompanionCanvasScene,
  "canvas.close": Empty,
  "artifact.history": CompanionArtifactHistoryResult,
  "artifact.moveCheck": CompanionArtifactMoveCheckResult,
  "artifact.pending": CompanionArtifactPendingResult,
  "artifact.apply": CompanionArtifactApplyResult,
  "artifact.get": CompanionArtifactGetResult,
  "artifacts.list": CompanionArtifactsListResult,
  "artifacts.nodes": CompanionArtifactsNodesResult,
  "inbox.set": CompanionInboxSetResult,
  "comments.list": CompanionCommentsListData,
  "comment.post": CompanionCommentPostData,
  "mentions.candidates": CompanionMentionCandidatesData,
  "mentions.resolve": CompanionMentionResolveData,
  "mentions.linkedFrom": CompanionMentionLinkedFromData,
  "artifacts.subscribe": Empty,
  "artifacts.unsubscribe": Empty,
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
  "unavailable",
  "mismatch",
  "disk-low",
] as const;
export const CompanionErrorCode = Schema.Literals(COMPANION_ERROR_CODES);
export type CompanionErrorCode = typeof CompanionErrorCode.Type;

export const CompanionError = Schema.Struct({
  code: CompanionErrorCode,
  /** Short, plain, safe to show: never secrets, tokens or terminal contents. */
  message: bounded(1, 500),
  /** `conflict` only: the signal as it now stands. */
  signal: Schema.optionalKey(AgentSignal),
  /** `conflict` on an artifact write only: which conflict, and the head to merge or take. */
  ...COMPANION_ARTIFACT_CONFLICT_FIELDS,
});
export type CompanionError = typeof CompanionError.Type;

// --- events ------------------------------------------------------------------

export const CompanionEvents = {
  hello: CompanionHello,
  "feed.changed": Schema.Struct({ feed: OperatorFeed }),
  "seat.changed": Schema.Struct({ canvasName: Schema.String, seat: CompanionSeat }),
  "signal.changed": Schema.Struct({ signal: AgentSignal }),
  "mail.changed": Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String, message: CompanionMail }),
  /** A thread of a seat whose threads this connection listed or opened: new mail, a read from any surface, a new title. An upsert by threadId. */
  "thread.changed": Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String, thread: CompanionThreadSummary }),
  preamble: Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String, preamble: CompanionPreamble }),
  "seat.removed": Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String }),
  "canvases.changed": Schema.Struct({ canvases: Schema.Array(CompanionCanvas) }),
  "machines.changed": Schema.Struct({ machines: Schema.Array(CompanionMachine) }),
  /** What changed on the open canvas since `seq - 1`, whole; any other seq is a gap: open it again. */
  "canvas.changed": Schema.Struct({
    canvasName: Schema.String,
    seq: Schema.Number.pipe(Schema.check(Schema.isInt())),
    nodes: Schema.Array(CompanionCanvasNode),
    wires: Schema.Array(CompanionCanvasWire),
    removedNodes: Schema.Array(NodeId),
    removedWires: Schema.Array(bounded(1, 256)),
  }),
  /** A comment landed on a subject this phone has a `comments.list` open on: list it again. */
  "comments.changed": CompanionCommentsChanged,
  /** An artifact on the subscribed canvas changed, by anyone. */
  "artifact.changed": CompanionArtifactChanged,
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
 * A signal, or a feed item, as it leaves on this wire: an automation's step
 * stays on the Mac. Its raised values alone run to 32 KB, so a seat's fifty
 * signals would overrun one frame, and the phone reads nothing in it. The
 * whole step goes, since `raised` is required inside it.
 */
export const companionSignal = <S extends { readonly source?: SignalSource }>(signal: S): S => {
  const source = signal.source;
  if (source?.kind !== "automation" || source.step === undefined) return signal;
  const { step: _step, ...rest } = source;
  return { ...signal, source: rest };
};

const companionFeed = (feed: OperatorFeed): OperatorFeed => ({
  ...feed,
  sections: feed.sections.map((section) => ({ ...section, items: section.items.map(companionSignal) })),
});

/** Every result that carries a signal or a feed, through companionSignal. */
const leavingResult = (op: CompanionOpName, result: unknown): unknown => {
  switch (op) {
    case "seat.get": {
      const { seat } = result as CompanionResultByOp["seat.get"];
      return { seat: { ...seat, signals: seat.signals.map(companionSignal) } };
    }
    case "signal.answer":
    case "signal.dismiss":
      return { signal: companionSignal((result as CompanionResultByOp["signal.answer"]).signal) };
    case "feed.get":
    case "feed.subscribe":
      return { feeds: (result as CompanionResultByOp["feed.get"]).feeds.map(companionFeed) };
    default:
      return result;
  }
};

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
  const encoded = Schema.encodeUnknownResult(CompanionResults[op] as unknown as Schema.Codec<unknown>)(leavingResult(op, result));
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
): CompanionError => ({ code, message, ...(signal ? { signal: companionSignal(signal) } : {}) });

const leavingEvent = (event: CompanionEventName, data: unknown): unknown => {
  switch (event) {
    case "signal.changed":
      return { signal: companionSignal((data as CompanionEventDataByName["signal.changed"]).signal) };
    case "feed.changed":
      return { feed: companionFeed((data as CompanionEventDataByName["feed.changed"]).feed) };
    default:
      return data;
  }
};

export const companionEvent = <E extends CompanionEventName>(
  event: E,
  data: CompanionEventDataByName[E],
): CompanionEventFrame =>
  ({ v: COMPANION_PROTOCOL, type: "event", event, data: leavingEvent(event, data) }) as CompanionEventFrame;

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
  unavailable: "This file is not available on the Mac.",
  mismatch: "The file changed on its way to the Mac. Attach it again.",
  "disk-low": "The Mac is low on disk space.",
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
  const size = utf8Bytes(line) + 1;
  if (size > COMPANION_MAX_INBOUND_BYTES) {
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
  const args = envelope.success.args ?? {};
  const op = envelope.success.op as CompanionOpName;
  // Only a file piece needs the larger frame; it does not widen any other op.
  if (op !== "content.stage" && size > COMPANION_MAX_REQUEST_BYTES) {
    return Result.fail({ id: "", error: companionError("too-large", COMPANION_ERROR_COPY["too-large"]), close: true });
  }
  // Args are closed: an unknown key is refused. So mail.send keeps its
  // optional `mentions` list, read and dropped (companion-core.ts), so an
  // older phone build that still sends it is not refused; drop the field
  // once no phone build sends it. A mention is the link in the text.
  const closed = !COMPANION_CLOSED_ARGS_OPS.has(op) ||
    Result.isSuccess(Schema.decodeUnknownResult(CompanionArgs[op], { onExcessProperty: "error" })(args));
  const frame = decodeRequestFrame({ ...(raw as object), args });
  if (!closed || Result.isFailure(frame)) {
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

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding, over UTF-8, with no platform encoder. */
export const base64UrlEncode = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
};

export const base64UrlDecode = (text: string): string => {
  const clean = text.replace(/=+$/u, "");
  if (!/^[A-Za-z0-9_-]*$/u.test(clean) || clean.length % 4 === 1) throw new Error("not base64url");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = clean.slice(i, i + 4);
    const n = [...chunk].reduce((acc, char, index) => acc | (B64.indexOf(char) << (18 - 6 * index)), 0);
    bytes.push((n >> 16) & 255);
    if (chunk.length > 2) bytes.push((n >> 8) & 255);
    if (chunk.length > 3) bytes.push(n & 255);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
};

export const companionPairingUrl = (payload: CompanionPairingPayload): string =>
  `junto-companion://pair?d=${base64UrlEncode(JSON.stringify(payload))}`;

export const decodeCompanionPairingUrl = (
  url: string,
): Result.Result<CompanionPairingPayload, string> => {
  const prefix = "junto-companion://pair?d=";
  if (!url.startsWith(prefix)) return Result.fail("not a pairing link");
  try {
    const json = base64UrlDecode(url.slice(prefix.length));
    const decoded = Schema.decodeUnknownResult(CompanionPairingPayload)(JSON.parse(json));
    return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail("invalid pairing payload");
  } catch {
    return Result.fail("invalid pairing payload");
  }
};
