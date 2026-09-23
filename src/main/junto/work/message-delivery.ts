// Message delivery — one-way nudge from ether.messages onto live transports.
// Actor targets come from kind-discriminated surfaces (managed terminal seats
// and raw geography shells). Geography holds no inbox, so a raw shell is not
// a delivery target. No delivery daemon, no retry queue, no polling.
//
// Durable stop condition is work_delivery_receipts (delivery.accepted), not a
// canvas metadata stamp — work overlays are stripped on authorial write.

import type { CanvasDoc, CanvasNode, Message } from "@shared/canvas";
import {
  composeImmediatePromptPayload,
  composeMessageDeliveryPayload,
  composeMessageDeliverySummary,
  deliveryTargetOf,
  isMessageDelivered,
  isMessageRead,
  isPendingDelivery,
  listPendingDeliveries,
  ptyInjectMarksRead,
  sortMessagesNewestFirst,
  MESSAGE_PTY_FULL_BODY_MAX,
  sanitizeDeliveryLine,
} from "@shared/message-delivery";
import type { SurfaceDeliveryTarget } from "@shared/actor-surface";
import {
  admitImmediatePrompt,
  mailAttemptReasonOfRefusal,
  readMailExtension,
  type DeliveryAttempt,
  type MailAttemptReason,
  type MailDeliveryPolicy,
  type MailWriteEvidence,
  type ManagedPromptOutcome,
  type ManagedPromptRefusalReason,
} from "@shared/managed-prompt";

/**
 * First re-drive delay after a delivery could not run (seat not up yet, a
 * draft or dialog on screen). Repeated polls back off from here.
 */
export const MESSAGE_DELIVERY_RETRY_MS = 1_500;

/**
 * Ceiling for the backed-off gate re-poll. Defense in depth only: the cadence
 * was never the cost, the per-attempt world read was. Every refusal reason
 * that backs off here also has a real state-change trigger
 * (`onManagedTerminalIdle` / `onTerminalAttached` / `onResumedCanvas`), so
 * the ceiling bounds the worst case where NOTHING changes — never the normal case.
 */
export const MESSAGE_DELIVERY_GATE_RETRY_MAX_MS = 12_000;

/**
 * Floor for a full world reconcile of the pending-mail index.
 *
 * The index is maintained incrementally — remembered when a message is
 * appended or seen pending by a document read, forgotten on the durable
 * receipt, on removal, or once the mailbox marks it read. That makes one seat
 * transition cost its own delta.
 *
 * A durable append that never announced itself is the one thing the index
 * cannot see (station fact ingress writes the inbox row straight through the
 * repository, not through `notifyAppended`). So a narrowed pass older than
 * this floor reconciles against the world first. Staleness is bounded; mail is
 * never dropped, only late.
 */
export const MESSAGE_DELIVERY_INDEX_RECONCILE_MS = 60_000;
/** Spread simultaneous seats off one tick so N refusals are not one block. */
const GATE_RETRY_JITTER_FRACTION = 0.2;

/**
 * Seat liveness for delivery. Mail is never gated on what the agent is
 * doing: an idle and a working seat both take mail, and the harness queues
 * or steers it by its own rules. Only a seat with no live generation waits.
 */
export type SeatDeliveryGateResult =
  | {
      readonly allow: true;
      /**
       * Opaque seat generation the gate observed, when the snapshot
       * transport reports one. Durable attempt identity uses this string —
       * never the drive terminal-epoch number, a distinct field.
       */
      readonly generationKey?: string;
    }
  | { readonly allow: false; readonly reason: "unavailable" };

export type MessageDeliveryTransport = {
  /** Start a local lazy managed seat before the first delivery attempt. */
  readonly wakeManagedSeat?: (
    canvas: string,
    nodeId: string,
  ) => boolean | Promise<boolean>;
  /** Paste without submitting (raw geography shells only). */
  readonly sendTerminalPaste?: (bindingId: string, text: string, messageId: string) => boolean;
  /**
   * Managed-terminal drive: paste+CR into an agent seat PTY, idle or mid-turn
   * alike (the harness queues or steers mail typed during a turn). Resolves
   * the discriminated attempt outcome: submitted (receiptable),
   * refused-before-write (retryable, no bytes on the PTY), or
   * written-unresolved (visible, same generation must not replay).
   */
  readonly sendManagedTerminalPrompt?: (
    bindingId: string,
    text: string,
    options?: ManagedTerminalPromptOptions,
  ) => Promise<ManagedPromptOutcome>;
  /**
   * Monotonic paste-envelope counter from the managed drive. When a failed
   * attempt wrote NOTHING to the PTY (gate race, seat left idle), the
   * at-most-once bookkeeping below is rolled back — those bounds exist to
   * stop re-pasting text already on the PTY, not to park a notice a refusal
   * never typed. Absent → attempts are counted unconditionally.
   */
  readonly pasteWriteCount?: (bindingId: string) => number;
  /**
   * The seat's live generation, or undefined while no generation is up.
   * Absent → allow (unit tests without a host). Screen guards (draft,
   * dialog) belong to the drive, which reads the grid at the paste moment.
   */
  readonly seatDeliverySnapshot?: (
    bindingId: string,
  ) =>
    | SeatDeliverySnapshot
    | undefined
    | Promise<SeatDeliverySnapshot | undefined>;
};

export type SeatDeliverySnapshot = {
  readonly generationKey: string;
};

export type ManagedTerminalPromptOptions = {
  /** Allow the drive to retain a prompt while a freshly-woken seat reaches idle. */
  readonly ready?: boolean;
  /**
   * Write into a working seat as well as an idle one. Every mail write sets
   * it; the drive never parks it, so a refusal returns here to retry.
   */
  readonly whileWorking?: boolean;
  /** Caller abort, threaded through to the drive's own abort handling. */
  readonly signal?: AbortSignal;
};

/**
 * Explicit immediate-prompt request against one durable row. The row must
 * already exist (the caller persists first); the same message id retries
 * the same row. An explicit `"notice"` fallback persists ordinary notice
 * policy for that row, including later automatic delivery.
 */
export type PromptRequest = {
  readonly canvas: string;
  readonly nodeId: string;
  readonly messageId: string;
  readonly fallback?: "notice";
  /**
   * Caller abort (e.g. live edge revocation racing the attempt). An
   * already-aborted signal refuses cancelled before touching anything;
   * mid-attempt aborts resolve through the drive as cancelled.
   */
  readonly signal?: AbortSignal;
};

/** Rows the explicit path cannot submit; a requested policy may be persisted. */
export type PromptUnavailable =
  | "gone"
  | "paused"
  | "settled"
  | "parked"
  | "unconfigured";

export type PromptResult =
  | {
      readonly outcome: ManagedPromptOutcome;
      readonly policy: MailDeliveryPolicy;
    }
  | { readonly unavailable: PromptUnavailable };

/** Operator multi-prompt rows re-drive at seat boundaries; other prompts stay explicit-only. */
export const isOperatorPromptRow = (message: Message): boolean =>
  message.metadata?.operatorPrompt === true;

/**
 * Durable delivery-attempt ledger (storage lane: work/mail-attempt-store.ts
 * adapts work/crew-repository.ts to this seam). The delivery layer never
 * invents the recipient ActorRef — it passes canvas, node, message, and the
 * seat generation string, and the adapter resolves the seat principal
 * against the seat compilation it owns. Agreed call order per attempt:
 * enqueue (batch: enqueueBatch, atomic membership) before any transport
 * action, markAttempted immediately before the physical write, recordAttempt
 * after the outcome. A clean queued row (no intent witness, no outcome) is
 * safe — nothing was written yet. Uncertainty is attempted-with-no-outcome:
 * the intent witness proves a write may have happened, so boot
 * reconciliation turns those rows unresolved and a crash cannot blindly
 * replay the same generation.
 */
export type AttemptMemberInput = {
  readonly messageId: string;
  readonly generation: string;
  readonly policy: MailDeliveryPolicy;
};

export type MessageDeliveryAttemptStore = {
  /**
   * Durably queue one attempt BEFORE any transport action. Idempotent on
   * (canvas, node, message, seat, generation). A clean queued row is safe;
   * uncertainty begins at the intent witness (markAttempted).
   */
  readonly enqueueAttempt: (
    input: {
      readonly canvas: string;
      readonly nodeId: string;
      readonly messageId: string;
      readonly generation: string;
      readonly policy: MailDeliveryPolicy;
      readonly at?: string;
    },
  ) => Promise<DeliveryAttempt>;
  /**
   * Durably commit one batch's membership BEFORE any member transport
   * action. Atomic: either every member row exists or none does. The
   * batchId is the delivery batch key shared by the members' payload.
   */
  readonly enqueueBatch: (
    input: {
      readonly canvas: string;
      readonly nodeId: string;
      readonly batchId: string;
      readonly members: ReadonlyArray<AttemptMemberInput>;
      readonly at?: string;
    },
  ) => Promise<ReadonlyArray<DeliveryAttempt>>;
  /**
   * Stamp the attempted_at intent witness immediately before the physical
   * write. A row left attempted with no outcome fact is a crashed intent:
   * boot reconciliation turns it unresolved, never a blind replay.
   */
  readonly markAttempted: (
    input: {
      readonly canvas: string;
      readonly nodeId: string;
      readonly messageId: string;
      readonly generation: string;
      readonly at?: string;
    },
  ) => Promise<DeliveryAttempt>;
  /**
   * Record one outcome fact plus physical write evidence. Set-once per
   * fact, monotonic, never overwrites: submitted maps to notifiedAt,
   * written-unresolved to unresolvedAt, pre-write refusal to
   * refusedAt plus refusedReason.
   */
  readonly recordAttempt: (
    input: {
      readonly canvas: string;
      readonly nodeId: string;
      readonly messageId: string;
      readonly generation: string;
      readonly set:
        | { readonly notifiedAt: string }
        | { readonly unresolvedAt: string }
        | {
            readonly refusedAt: string;
            readonly refusedReason: MailAttemptReason;
          };
      readonly write?: MailWriteEvidence;
    },
  ) => Promise<DeliveryAttempt>;
  /** Read one attempt row, if the adapter has it. */
  readonly attempt: (
    input: {
      readonly canvas: string;
      readonly nodeId: string;
      readonly messageId: string;
      readonly generation: string;
    },
  ) => Promise<DeliveryAttempt | undefined>;
  /**
   * True when any generation holds a notified fact for this message and
   * seat. Gates cross-generation suppression: a notified row without a
   * durable receipt stamps only, never repastes.
   */
  readonly hasNotifiedAcrossGenerations: (
    input: {
      readonly canvas: string;
      readonly nodeId: string;
      readonly messageId: string;
    },
  ) => Promise<boolean>;
  /**
   * Turn crashed intents (attempted, no outcome fact) into unresolved rows.
   * Called once at boot before the first sweep.
   */
  readonly reconcileUnresolvedAttempts: (at: string) => Promise<number>;
  /**
   * Operator-authorized fresh attempt for a same-generation held row: opens
   * a new intent without clearing any fact. True when a grant was issued.
   * Optional: older stores omit it, and the hold then never releases (the
   * pre-grant behavior). The product composition always provides it.
   */
  readonly grantHeldAttempt?: (input: {
    readonly canvas: string;
    readonly nodeId: string;
    readonly messageId: string;
    readonly generation: string;
    readonly at?: string;
  }) => Promise<boolean>;
  /** Held (unresolved, un-notified) rows for one canvas. Optional, as above. */
  readonly listHeldAttempts?: (
    canvas: string,
  ) => Promise<ReadonlyArray<DeliveryAttempt>>;
  /**
   * Persist a notice-fallback marker (idempotent): an explicit request
   * re-admits an explicit-only prompt-kind row to the ordinary notice path.
   * Optional, as above.
   */
  readonly grantNoticeFallback?: (input: {
    readonly canvas: string;
    readonly nodeId: string;
    readonly messageId: string;
    readonly reason: string;
    readonly at?: string;
  }) => Promise<boolean>;
  /** True when a fallback marker exists for this message and seat. */
  readonly hasNoticeFallback?: (input: {
    readonly canvas: string;
    readonly nodeId: string;
    readonly messageId: string;
  }) => Promise<boolean>;
};

/**
 * Which delivery path drove one full-document read. Instrumentation only —
 * it never reaches SQLite, the document, or a product surface. It exists so
 * the perf tape attributes a read loop to a call site instead of lumping every
 * delivery read under one tag.
 */
export type MessageDeliveryReadSite = "scan" | "attempt" | "batch";

/**
 * One node's authorial structure, read without building the work projection.
 *
 * `structure` carries NO work lanes (`ether.messages` and friends are absent).
 * It is here only for the pause geography `seatPaused` needs; anything that
 * reads a message must take the full document.
 */
export type MessageDeliveryNodeStructure = {
  readonly node: CanvasNode;
  readonly structure: CanvasDoc;
};

export type MessageDeliveryStore = {
  readonly listCanvasNames: () => Promise<ReadonlyArray<string>>;
  readonly readDoc: (
    canvas: string,
    site: MessageDeliveryReadSite,
  ) => Promise<CanvasDoc | undefined>;
  /**
   * Node-scoped authority lookup — same freshness as `readDoc`, without the
   * work projection.
   *
   * Delivery ROUTING asks structural questions only: does this node still
   * exist, which seat does it bind to, is that seat paused. Answering them
   * through `readDoc` materializes every sink on the canvas, which is what
   * turned the gate-retry cadence into a full-world read loop.
   *
   * Contract: `undefined` means the node is GONE (a durable answer — callers
   * may retire queued work for it). A failed read must REJECT, never resolve
   * undefined, so a transient authority error leaves queued work queued.
   */
  readonly readNodeStructure: (
    canvas: string,
    nodeId: string,
  ) => Promise<MessageDeliveryNodeStructure | undefined>;
  /**
   * Durable stop: true when delivery.accepted exists for this mailbox message.
   * (work_delivery_receipts — same plane as managed task claim delivery.)
   */
  readonly hasAcceptedMessageDelivery: (
    canvas: string,
    nodeId: string,
    messageId: string,
  ) => Promise<boolean>;
  /**
   * Durable stop for the full-body read stamp: true when the read receipt
   * exists for this mailbox message (work_delivery_receipts, read id).
   */
  readonly hasAcceptedMessageRead: (
    canvas: string,
    nodeId: string,
    messageId: string,
  ) => Promise<boolean>;
  /**
   * Record delivery.accepted after the PTY transport accepted the inject.
   * Returns true when the receipt is durable (or already existed).
   */
  readonly acceptMessageDelivery: (
    canvas: string,
    nodeId: string,
    messageId: string,
  ) => Promise<boolean>;
  /**
   * Record a read receipt after a full-body PTY inject.
   * Returns true when the receipt is durable (or already existed).
   */
  readonly acceptMessageRead: (
    canvas: string,
    nodeId: string,
    messageId: string,
  ) => Promise<boolean>;
};

export type MessageDeliveryClock = () => number;

/** Deferred-retry seam — injectable so tests never sleep. */
export type MessageDeliveryTimers = {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
};

const defaultTimers: MessageDeliveryTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const flightKey = (canvas: string, nodeId: string, messageId: string): string =>
  `${canvas}::${nodeId}::${messageId}`;

const nodeKey = (canvas: string, nodeId: string): string => `${canvas}::${nodeId}`;

/** Edge-map grant claim carried by a notice (metadata.addedIds), narrowed. */
const edgeMapAddedIds = (message: Message): ReadonlyArray<string> => {
  const added = message.metadata?.addedIds;
  return Array.isArray(added)
    ? added.filter((id): id is string => typeof id === "string")
    : [];
};

/** True when the current doc still connects `seatId` to `targetId` (undirected edge, target present). */
const isConnectedTarget = (
  doc: CanvasDoc,
  seatId: string,
  targetId: string,
): boolean =>
  doc.nodes.some((n) => n.id === targetId) &&
  doc.edges.some(
    (e) =>
      (e.fromNode === seatId && e.toNode === targetId) ||
      (e.fromNode === targetId && e.toNode === seatId),
  );

/**
 * Cheap canonical fingerprint of the canvas edge map (edges + node kinds).
 * Detects a REAL state change before re-driving a grant-claiming notice that
 * was already attempted in this process: no edge-map delta, no re-paste.
 */
const docTopologySignature = (doc: CanvasDoc): string => {
  const edges = doc.edges
    .map((e) => `${e.fromNode}->${e.toNode}`)
    .sort()
    .join(",");
  const kinds = doc.nodes
    .map((n) => `${n.id}:${n.ether?.entity?.kind ?? ""}`)
    .sort()
    .join(",");
  return `${edges}|${kinds}`;
};

export class MessageDeliveryService {
  private readonly inFlight = new Set<string>();
  /**
   * Process-local: transport accepted the nudge but document stamp may lag.
   * Later attach/idle re-drives must stamp only — never re-send (at-most-once).
   */
  private readonly transportAccepted = new Set<string>();
  /**
   * Same-generation uncertainty hold: a prior attempt wrote bytes without
   * submission proof (here or, via the ledger row, in an earlier process).
   * While held, re-drives do neither transport nor receipt — only a new
   * recipient generation, an explicit resume, or operator action releases.
   * Maps flight key to the seat generation string the attempt ran under.
   */
  private readonly transportUnresolved = new Map<string, string>();
  /**
   * Immutable membership of each batch whose transport was accepted. A later
   * recovery may see newer pending mail on the same seat, but that mail was not
   * part of the accepted payload and must never receive its receipt here.
   */
  private readonly acceptedBatchMembers = new Map<string, ReadonlySet<string>>();
  /**
   * Delivery receipt landed, full-body read stamp did not. Later scans retry
   * acceptMessageRead only — never the PTY paste.
   */
  private readonly pendingReadStamps = new Map<
    string,
    { readonly canvas: string; readonly nodeId: string; readonly message: Message }
  >();
  /**
   * Process-local transport-attempt count per message (flightKey). Backstop
   * bound for ALL messages (live duplicate fix): after MAX_TRANSPORT_ATTEMPTS
   * failed transport attempts the message is parked — no further transport
   * hits — until the durable receipt lands, the message is removed, or the
   * seat resumes (operator action). Edge-map notices are additionally bounded
   * per canvas edge-map state (attemptedClaims).
   */
  private readonly transportAttempts = new Map<string, number>();
  private static readonly MAX_TRANSPORT_ATTEMPTS = 3;
  /**
   * Process-local bounded re-drive for grant-claiming edge-map notices: after
   * one transport attempt, the identical un-receipted notice must not be
   * re-pasted on every idle — re-drives are suppressed until the canvas edge
   * map changes (a real state change; the notice is then re-validated against
   * the current doc before any paste). Cleared on reset, suspension, and
   * pause release (resume is an operator action — a real state change).
   */
  private readonly attemptedClaims = new Map<string, { readonly signature: string }>();
  /**
   * Wake-refused messages get a bounded chain of deferred re-attempts —
   * without one, mail appended to a cold seat that refuses its first wake
   * (restart backoff, transient authority miss) has NO future trigger and
   * parks forever. Doubling delays step through the seat restart backoff.
   */
  private readonly wakeRetryTimers = new Map<string, unknown>();
  private readonly wakeRetryCounts = new Map<string, number>();
  private static readonly WAKE_RETRY_MAX = 5;
  private static readonly WAKE_RETRY_BASE_MS = 45_000;
  /** One refusal log per pending message, not one per idle-scan re-attempt. */
  private readonly wakeRefusalLogged = new Set<string>();
  private readonly lastGenerationKey = new Map<string, string>();
  /**
   * Deferred re-scan after a delivery could not run (seat not up, or the
   * drive refused a draft or dialog screen) so a seat with no further state
   * transition still receives mail. Keyed by bindingId — one timer per seat.
   */
  private readonly gateRetryTimers = new Map<string, unknown>();
  /**
   * Consecutive `poll` refusals per binding. Drives the re-poll backoff and is
   * cleared by any real state change — a gate that allows, a lifecycle event,
   * or a seat generation flip. A seat that is simply busy therefore never
   * accumulates backoff across turns.
   */
  private readonly gateRefusalStreak = new Map<string, number>();
  /**
   * Live pending-mail index: (canvas, nodeId) -> the messages that still owe a
   * notify. Incremental view maintenance — this is what lets one seat
   * transition cost its own delta instead of a read of every canvas.
   *
   * `seq` is a monotonic insert stamp. A reconcile prunes only what it can
   * prove stale: entries indexed BEFORE that world read began. A message
   * appended mid-read can never be pruned by a document older than it.
   */
  private readonly pendingIndex = new Map<
    string,
    {
      readonly canvas: string;
      readonly nodeId: string;
      readonly messages: Map<
        string,
        { readonly message: Message; readonly seq: number }
      >;
    }
  >();
  private indexSeq = 0;
  /** Clock stamp of the last COMPLETE world reconcile; undefined = never. */
  private lastReconcileAtMs: number | undefined;
  private timers: MessageDeliveryTimers = defaultTimers;
  private random: () => number = Math.random;
  private readonly pendingRequestResponses = new Map<
    string,
    {
      readonly canvas: string;
      readonly actorNodeId: string;
      readonly requestId: string;
      readonly response: string;
    }
  >();
  private transport: MessageDeliveryTransport | undefined;
  private store: MessageDeliveryStore | undefined;
  private attempts: MessageDeliveryAttemptStore | undefined;
  private now: MessageDeliveryClock = () => Date.now();
  private suspended = false;
  private lifecycleGeneration = 0;

  private seatPausedLookup: ((canvas: string, doc: CanvasDoc, nodeId: string) => boolean) | undefined;
  private releaseSeatHold:
    | ((bindingId: string, generation: string) => void)
    | undefined;

  configure(input: {
    readonly transport: MessageDeliveryTransport;
    readonly store: MessageDeliveryStore;
    /**
     * Durable attempt ledger. Absent in unit doubles — delivery then keeps
     * legacy in-memory transport marks only (no grants, no fallback).
     */
    readonly attempts?: MessageDeliveryAttemptStore;
    readonly now?: MessageDeliveryClock;
    /** Pause plane: a paused target keeps its messages pending (delivered on resume). */
    readonly seatPaused?: (canvas: string, doc: CanvasDoc, nodeId: string) => boolean;
    readonly timers?: MessageDeliveryTimers;
    /** Jitter seam — injectable so retry spread is deterministic in tests. */
    readonly random?: () => number;
    /**
     * Same-generation resume authorization outlet: after the service grants
     * held rows on an explicit resume, it releases the drive's
     * written-unresolved hold per granted binding so the authorized retry
     * can actually paste. The release carries the granted generation so
     * the composition can verify it is still current before touching the
     * drive. The composition wires the drive's release here; the service
     * never touches the drive directly.
     */
    readonly releaseSeatHold?: (bindingId: string, generation: string) => void;
  }): void {
    if (this.suspended) return;
    this.transport = input.transport;
    this.store = input.store;
    if (input.attempts) this.attempts = input.attempts;
    if (input.now) this.now = input.now;
    this.seatPausedLookup = input.seatPaused;
    if (input.timers) this.timers = input.timers;
    if (input.random) this.random = input.random;
    this.releaseSeatHold = input.releaseSeatHold;
  }

  /** Test seam — drop all in-flight marks and deps. */
  resetForTest(): void {
    this.lifecycleGeneration += 1;
    this.inFlight.clear();
    this.transportAccepted.clear();
    this.transportUnresolved.clear();
    this.acceptedBatchMembers.clear();
    this.pendingReadStamps.clear();
    this.transportAttempts.clear();
    this.attemptedClaims.clear();
    this.pendingRequestResponses.clear();
    this.clearWakeRetries();
    this.wakeRefusalLogged.clear();
    this.lastGenerationKey.clear();
    this.clearGateRetries();
    this.clearPendingIndex();
    this.transport = undefined;
    this.store = undefined;
    this.attempts = undefined;
    this.releaseSeatHold = undefined;
    this.now = () => Date.now();
    this.seatPausedLookup = undefined;
    this.timers = defaultTimers;
    this.random = Math.random;
    this.suspended = false;
  }

  /**
   * Monotonically stop product-driven delivery for this process.
   *
   * Pending messages remain durable and unstamped for a later app
   * process. Already accepted transport writes may finish their delivery
   * stamp, but no attach/idle/resume scan may reach a PTY after this cut.
   */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.lifecycleGeneration += 1;
    this.transport = undefined;
    this.store = undefined;
    this.attempts = undefined;
    this.seatPausedLookup = undefined;
    this.releaseSeatHold = undefined;
    this.inFlight.clear();
    this.transportAccepted.clear();
    this.transportUnresolved.clear();
    this.acceptedBatchMembers.clear();
    this.pendingReadStamps.clear();
    this.transportAttempts.clear();
    this.attemptedClaims.clear();
    this.pendingRequestResponses.clear();
    this.clearWakeRetries();
    this.wakeRefusalLogged.clear();
    this.lastGenerationKey.clear();
    this.clearGateRetries();
    this.clearPendingIndex();
  }

  private clearPendingIndex(): void {
    this.pendingIndex.clear();
    this.indexSeq = 0;
    this.lastReconcileAtMs = undefined;
  }

  /**
   * Index one pending message. Called where a pending delivery is CREATED
   * (`notifyAppended`) and wherever a document read observes one still
   * pending — a cold index therefore rebuilds itself from the first world
   * read after a restart.
   */
  private rememberPending(
    canvas: string,
    nodeId: string,
    message: Message,
  ): void {
    if (!isPendingDelivery(message)) return;
    const key = nodeKey(canvas, nodeId);
    let entry = this.pendingIndex.get(key);
    if (!entry) {
      entry = { canvas, nodeId, messages: new Map() };
      this.pendingIndex.set(key, entry);
    }
    this.indexSeq += 1;
    entry.messages.set(message.messageId, { message, seq: this.indexSeq });
  }

  /**
   * Drop one message from the index. Only ever called on positive evidence
   * from a fresh authority read: the durable receipt landed, the mailbox
   * marked it read, or the message is gone from the document.
   */
  private forgetPending(
    canvas: string,
    nodeId: string,
    messageId: string,
  ): void {
    const key = nodeKey(canvas, nodeId);
    const entry = this.pendingIndex.get(key);
    if (!entry) return;
    entry.messages.delete(messageId);
    if (entry.messages.size === 0) this.pendingIndex.delete(key);
  }

  /** The node itself is gone from authority — retire everything queued on it. */
  private forgetNode(canvas: string, nodeId: string): void {
    this.pendingIndex.delete(nodeKey(canvas, nodeId));
  }

  /**
   * Prune this canvas's index against what the world read actually observed.
   * Entries stamped at or after `startSeq` arrived after the read began, so
   * the document cannot speak to them and they survive.
   */
  private reconcileCanvasIndex(
    canvas: string,
    observed: ReadonlyMap<string, ReadonlySet<string>>,
    startSeq: number,
  ): void {
    for (const [key, entry] of [...this.pendingIndex]) {
      if (entry.canvas !== canvas) continue;
      const live = observed.get(entry.nodeId);
      for (const [messageId, held] of [...entry.messages]) {
        if (held.seq >= startSeq) continue;
        if (live?.has(messageId) === true) continue;
        entry.messages.delete(messageId);
      }
      if (entry.messages.size === 0) this.pendingIndex.delete(key);
    }
  }

  /** True when the index was never built, or the reconcile floor has elapsed. */
  private reconcileDue(): boolean {
    const last = this.lastReconcileAtMs;
    if (last === undefined) return true;
    return this.now() - last >= MESSAGE_DELIVERY_INDEX_RECONCILE_MS;
  }

  private clearWakeRetries(): void {
    for (const handle of this.wakeRetryTimers.values()) {
      this.timers.clear(handle);
    }
    this.wakeRetryTimers.clear();
    this.wakeRetryCounts.clear();
  }

  private clearGateRetries(): void {
    for (const handle of this.gateRetryTimers.values()) {
      this.timers.clear(handle);
    }
    this.gateRetryTimers.clear();
    this.gateRefusalStreak.clear();
  }

  /**
   * Delay for the next re-drive. Nothing says when a draft clears or a seat
   * comes up, so consecutive refusals double the wait up to the ceiling.
   * Jitter is symmetric so a floor of seats refusing together stops landing on
   * one tick (and one block).
   */
  private gateRetryDelay(bindingId: string, requestedMs: number): number {
    const streak = this.gateRefusalStreak.get(bindingId) ?? 0;
    this.gateRefusalStreak.set(bindingId, streak + 1);
    const backedOff = Math.min(
      MESSAGE_DELIVERY_GATE_RETRY_MAX_MS,
      requestedMs * 2 ** streak,
    );
    const spread = backedOff * GATE_RETRY_JITTER_FRACTION;
    return Math.max(10, backedOff - spread + this.random() * spread * 2);
  }

  /**
   * Re-drive one binding after a refusal without waiting for a seat-state
   * transition (a seat that stays in one state never re-fires an event).
   */
  private scheduleGateRetry(bindingId: string, delayMs: number): void {
    if (this.gateRetryTimers.has(bindingId)) return;
    const generation = this.lifecycleGeneration;
    const handle = this.timers.set(() => {
      this.gateRetryTimers.delete(bindingId);
      if (!this.active(generation)) return;
      void this.deliverForBinding(bindingId);
      // Request-response shares the seat gate; re-drive those too.
      void this.retryRequestResponses(bindingId);
    }, this.gateRetryDelay(bindingId, delayMs));
    this.gateRetryTimers.set(bindingId, handle);
  }

  private active(generation: number): boolean {
    return !this.suspended && generation === this.lifecycleGeneration;
  }

  /**
   * Explicit immediate prompt against one durable row. Bypasses the
   * auto-notice machinery (no index, no batch, no interrupt, no drive
   * queue): idle plus empty composer plus short body, else a retryable
   * refusal the caller retries against the same message id. Submitted
   * attempts receipt exactly like mail; unresolved sets the same-generation
   * hold a later explicit retry will itself observe.
   */
  async prompt(input: PromptRequest): Promise<PromptResult> {
    const generation = this.lifecycleGeneration;
    const transport = this.transport;
    const store = this.store;
    if (this.suspended || !transport || !store) {
      return { unavailable: "unconfigured" };
    }
    let doc: CanvasDoc | undefined;
    try {
      doc = await store.readDoc(input.canvas, "attempt");
    } catch {
      throw new Error(
        `[delivery] prompt authority read failed for ${input.canvas}/${input.nodeId}/${input.messageId}`,
      );
    }
    if (!this.active(generation)) return { unavailable: "unconfigured" };
    const node = doc?.nodes.find((n) => n.id === input.nodeId);
    if (!doc || !node) return { unavailable: "gone" };
    const live = node.ether?.messages?.items.find(
      (m) => m.messageId === input.messageId,
    );
    if (!live) return { unavailable: "gone" };
    if (!isPendingDelivery(live)) return { unavailable: "settled" };
    const target = deliveryTargetOf(node);
    if (!target) return { unavailable: "gone" };
    const extension = readMailExtension(live.metadata);
    const policy: MailDeliveryPolicy =
      input.fallback === "notice"
        ? "notice"
        : extension?.mailKind === "prompt"
          ? "immediate"
          : "notice";
    const key = flightKey(input.canvas, input.nodeId, input.messageId);
    if (input.signal?.aborted) {
      return {
        outcome: this.refusedWithoutWrite("cancelled"),
        policy,
      };
    }
    if (this.inFlight.has(key)) {
      return {
        outcome: this.refusedWithoutWrite("seat-busy"),
        policy,
      };
    }
    this.inFlight.add(key);
    try {
      // Reserve this message before publishing its ordinary-notice policy:
      // a concurrent scan must not start a second attempt while the marker
      // write is pending. Only an explicit request changes prompt policy.
      if (input.fallback === "notice" && extension?.mailKind === "prompt") {
        await this.attempts?.grantNoticeFallback?.({
          canvas: input.canvas,
          nodeId: input.nodeId,
          messageId: live.messageId,
          reason: "explicit",
        });
        // A failed durable write throws rather than pretending the requested
        // fallback will survive restart. Cancellation before admission never
        // persists a marker; cancellation during the write can retain the
        // already-authorized policy, but cannot continue this transport.
        if (!this.active(generation)) return { unavailable: "unconfigured" };
        if (input.signal?.aborted) {
          return { outcome: this.refusedWithoutWrite("cancelled"), policy };
        }
      }
      if (this.seatPausedLookup?.(input.canvas, doc, input.nodeId)) {
        return { unavailable: "paused" };
      }
      if (!(await this.checkUnresolvedHold(target.bindingId, key))) {
        // Prior attempt in this generation wrote without proof. An
        // ordinary same-id retry stays non-replayable: only a new
        // generation, an explicit resume batch, or operator action
        // authorizes another paste.
        return {
          outcome: this.refusedWithoutWrite("written-unresolved"),
          policy,
        };
      }
      // Immediate policy never starts a stopped seat to satisfy itself:
      // only a currently idle, empty seat is admitted, otherwise SeatBusy.
      // The ordinary notice fallback keeps the wake (mail may start seats).
      if (policy !== "immediate") {
        const woke = await this.wakeManagedSeat(
          transport,
          input.canvas,
          input.nodeId,
        );
        if (!woke) {
          return { outcome: this.refusedWithoutWrite("not-ready"), policy };
        }
      }
      if (
        (this.transportAttempts.get(key) ?? 0) >=
        MessageDeliveryService.MAX_TRANSPORT_ATTEMPTS
      ) {
        // Parked after MAX attempts. A plain immediate prompt stays
        // immediate here — parking never auto-degrades it to notice. An
        // explicit notice fallback already persisted its marker write-ahead
        // at entry, so a restart (which clears the RAM park) still delivers
        // it as notice. Same-process notice scans park on the same counter.
        return { unavailable: "parked" };
      }
      const gate = await this.evaluateSeatGate(target.bindingId);
      if (!gate.allow) {
        // No live seat generation yet ("not now", not "never"). A plain
        // immediate prompt stays immediate; an explicit notice fallback
        // already persisted its marker write-ahead, so the scan re-admits it.
        return { outcome: this.refusedWithoutWrite("not-ready"), policy };
      }
      // Immediate prompts carry the full body under the server sender
      // envelope; an explicit notice fallback uses the ordinary summary
      // builder. Both write into an idle or working seat alike.
      const payload =
        policy === "immediate"
          ? composeImmediatePromptPayload(live)
          : composeMessageDeliveryPayload(live);
      const promptOptions = {
        ...(transport.wakeManagedSeat ? { ready: true } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const seatGeneration = gate.generationKey;
      const prep = await this.prepareAttempt(
        input.canvas,
        input.nodeId,
        live.messageId,
        key,
        seatGeneration,
        policy,
      );
      if (prep === "ledgerDown") {
        return { outcome: this.refusedWithoutWrite("not-ready"), policy };
      }
      if (prep === "held") {
        return {
          outcome: this.refusedWithoutWrite("written-unresolved"),
          policy,
        };
      }
      const stampOnly = prep === "stampOnly";
      if (
        policy === "immediate" &&
        // Stamp-only replays an already accepted row: no new write, so the
        // cap never applies.
        !stampOnly &&
        admitImmediatePrompt({
          // The 160 cap counts BODY characters only: strip the server
          // sender envelope (the payload's first line) before counting.
          bodyChars:
            payload.indexOf("\n") < 0
              ? payload.length
              : payload.length - payload.indexOf("\n") - 1,
        }).admitted === false
      ) {
        // Over-limit bodies never type: refuse with the durable oversize
        // reason instead of pasting a truncated turn.
        const overLimit: ManagedPromptOutcome = {
          status: "refused",
          reason: "over-limit",
          bindingGeneration: 0,
          writesBefore: 0,
          writesAfter: 0,
          pasteWrites: 0,
          wrotePhysicalBytes: false,
        };
        await this.recordAttemptOutcome(
          input.canvas,
          input.nodeId,
          live.messageId,
          seatGeneration,
          overLimit,
        );
        return { outcome: overLimit, policy };
      }
      let outcome: ManagedPromptOutcome | undefined;
      if (stampOnly) {
        // Acceptance evidence already durable: stamp-only with zero
        // new-write facts, no paste, no charge.
        outcome = this.stampedOnlyOutcome();
      } else {
        if (
          !(await this.markAttempt(
            input.canvas,
            input.nodeId,
            live.messageId,
            seatGeneration,
          ))
        ) {
          return { outcome: this.refusedWithoutWrite("not-ready"), policy };
        }
        this.transportAttempts.set(key, (this.transportAttempts.get(key) ?? 0) + 1);
        const writesBefore = transport.pasteWriteCount?.(target.bindingId);
        try {
          outcome = await this.deliver(
            transport,
            target,
            payload,
            live.messageId,
            promptOptions,
          );
        } finally {
          const counterEqual =
            writesBefore !== undefined &&
            transport.pasteWriteCount?.(target.bindingId) === writesBefore;
          const wroteNothing =
            outcome !== undefined &&
            outcome.status === "refused" &&
            !outcome.wrotePhysicalBytes;
          if (
            (outcome === undefined && counterEqual) ||
            (wroteNothing &&
              (writesBefore === undefined || counterEqual))
          ) {
            const charged = this.transportAttempts.get(key) ?? 0;
            if (charged > 0) this.transportAttempts.set(key, charged - 1);
          }
        }
        if (outcome === undefined) {
          return { outcome: this.refusedWithoutWrite("not-ready"), policy };
        }
      }
      await this.recordAttemptOutcome(
        input.canvas,
        input.nodeId,
        live.messageId,
        seatGeneration,
        outcome,
      );
      if (outcome.status === "unresolved") {
        this.transportAccepted.add(key);
        this.transportUnresolved.set(key, seatGeneration ?? "");
        return { outcome, policy };
      }
      if (outcome.status !== "submitted") {
        // Transport verdicts stand as returned. A plain immediate prompt
        // stays immediate — a transport busy never auto-degrades it to
        // notice. An explicit notice fallback already persisted its marker
        // write-ahead at entry.
        return { outcome, policy };
      }
      this.transportAccepted.add(key);
      const accepted = await this.acceptDeliveryAndMaybeRead(
        store,
        input.canvas,
        input.nodeId,
        live,
      );
      if (accepted) {
        this.pendingReadStamps.delete(key);
        this.clearAttemptBookkeeping(key);
        this.forgetPending(input.canvas, input.nodeId, live.messageId);
      }
      return { outcome, policy };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Called after a message lands on an actor node (WorkService append).
   * task-history appends never reach here (caller filters taskId !== null).
   */
  notifyAppended(canvas: string, nodeId: string, message: Message): void {
    if (this.suspended) return;
    if (!isPendingDelivery(message)) return;
    // Index first: if this attempt is refused, the seat's next transition is
    // what re-drives it, and that pass reads the index, not the world.
    // Prompt-kind rows stay explicit-only inside attemptOne unless an
    // operatorPrompt flag or a durable notice-fallback marker re-admitted
    // them. Ordinary creation still cannot race an explicit prompt attempt.
    this.rememberPending(canvas, nodeId, message);
    void this.attemptOne(canvas, nodeId, message);
  }

  /**
   * Push an operator's answer back into the exact live actor seat that raised
   * the request. The resolved request remains the durable source of truth;
   * this process-local entry is only the retryable transport nudge.
   */
  notifyRequestResolved(input: {
    readonly canvas: string;
    readonly actorNodeId: string;
    readonly requestId: string;
    readonly response: string;
  }): void {
    if (this.suspended) return;
    const key = `${input.canvas}::${input.actorNodeId}::request::${input.requestId}`;
    this.pendingRequestResponses.set(key, input);
    void this.attemptRequestResponse(key, input);
  }

  /**
   * One seat had a real state change — re-drive everything queued for it.
   *
   * A state change is also the only honest reason to drop the gate's backoff:
   * the condition the re-poll was waiting on may have just cleared, so the
   * next refusal starts over from the base delay rather than the ceiling.
   */
  private onSeatStateChanged(bindingId: string): void {
    this.gateRefusalStreak.delete(bindingId);
    void this.retryRequestResponses(bindingId);
    void this.deliverForBinding(bindingId);
  }

  /** Native terminal session attached — offer pending messages as unsubmitted paste. */
  onTerminalAttached(bindingId: string): void {
    if (this.suspended) return;
    this.onSeatStateChanged(bindingId);
  }

  /**
   * Managed seat became idle — re-drive pending for that binding. Mail does
   * not wait for idle, but a refusal (a dialog, a draft) often clears here.
   */
  onManagedTerminalIdle(bindingId: string): void {
    if (this.suspended) return;
    this.onSeatStateChanged(bindingId);
  }

  /**
   * The seat's composer was proven EMPTY on screen. A delivery refused at the
   * turn boundary (idle published before the composer repaint settled) has no
   * idle transition left to re-drive it — this boundary is what it waits on.
   */
  onComposerEmpty(bindingId: string): void {
    if (this.suspended) return;
    this.onSeatStateChanged(bindingId);
  }

  /**
   * Explicit resume transition (or operator retry) for ONE canvas — re-drive
   * only what pause held on that canvas. Narrow by construction: callers must
   * invoke this solely on a real resume transition, never on every
   * pause-state change while playing; other canvases are untouched. Held
   * rows get exactly one operator-authorized fresh intent each (granted
   * durably before the sweep); rows the grant does not cover re-hold on
   * their ledger truth.
   */
  onResumedCanvas(canvas: string): void {
    if (this.suspended) return;
    // Operator action: release this canvas's bounded re-drive marks so held
    // notices get one fresh attempt (re-validated against the current doc,
    // re-derived from the ledger).
    this.clearResumeMarks(`${canvas}::`);
    // Gate-retry timers are binding-keyed and keep their bounded schedules;
    // the sweep below re-drives this canvas immediately.
    void this.resumeCanvasSweep(canvas);
  }

  /**
   * Release bounded re-drive marks for one scope (a canvas prefix, or every
   * key when the prefix is undefined). Held uncertainty drops its accepted
   * mark ALONGSIDE the hold: the next attempt must re-derive from the ledger
   * (hold again without a durable retry grant), never skip the transport on
   * a stale accepted mark and stamp a delivery receipt for bytes that were
   * never acknowledged. Accepted-but-unreceipted marks outside a hold are
   * kept, preserving stamp-only recovery.
   */
  private clearResumeMarks(prefix?: string): void {
    const scoped = (key: string): boolean =>
      prefix === undefined || key.startsWith(prefix);
    for (const key of [...this.transportUnresolved.keys()]) {
      if (!scoped(key)) continue;
      this.transportUnresolved.delete(key);
      this.transportAccepted.delete(key);
    }
    const dropScoped = (
      keys: Iterable<string>,
      drop: (key: string) => void,
    ): void => {
      for (const key of [...keys]) {
        if (scoped(key)) drop(key);
      }
    };
    dropScoped(this.attemptedClaims.keys(), (key) => {
      this.attemptedClaims.delete(key);
    });
    dropScoped(this.transportAttempts.keys(), (key) => {
      this.transportAttempts.delete(key);
    });
    dropScoped(this.wakeRetryCounts.keys(), (key) => {
      this.wakeRetryCounts.delete(key);
    });
    dropScoped(this.wakeRefusalLogged, (key) => {
      this.wakeRefusalLogged.delete(key);
    });
    for (const [key, handle] of [...this.wakeRetryTimers]) {
      if (scoped(key)) {
        this.timers.clear(handle);
        this.wakeRetryTimers.delete(key);
      }
    }
  }

  /**
   * Same-generation explicit-resume authorization: open exactly one fresh
   * intent per held row on this canvas — durably, BEFORE any transport —
   * then release the drive hold so the authorized retry can actually paste.
   * Idle and pulse scans never grant; only this explicit path does. Rows
   * already notified, already open, or gone from the document grant nothing.
   * A crash between grant and transport leaves an open intent that boot
   * reconciliation closes back into the hold (never a blind replay).
   *
   * Generation-fenced: a held row is granted only when its recorded
   * generation equals the seat's CURRENT transport generation, read fresh
   * before the grant — and the drive hold is released only when that
   * equality still holds after the grant write lands, because the seat may
   * have cut generation while the grant was in flight. Granting (or
   * releasing) an old generation's row authorizes a paste the current
   * ledger never opened: a duplicate physical write with no intent behind
   * it. The release carries the granted generation so the composition can
   * verify it against the current host before touching the drive.
   */
  private async grantResumeRetries(
    canvas: string,
    generation: number,
  ): Promise<void> {
    const ledger = this.attempts;
    if (ledger?.listHeldAttempts === undefined) return;
    if (ledger?.grantHeldAttempt === undefined) return;
    let held;
    try {
      held = await ledger.listHeldAttempts(canvas);
    } catch {
      return;
    }
    if (!this.active(generation) || held.length === 0) return;
    let doc;
    try {
      doc = await this.store?.readDoc(canvas, "scan");
    } catch {
      return;
    }
    if (!this.active(generation) || !doc) return;
    const releasedBindings = new Set<string>();
    for (const row of held) {
      if (!this.active(generation)) return;
      const node = doc.nodes.find((n) => n.id === row.recipient.seat.nodeId);
      const live = node?.ether?.messages?.items.find(
        (m) => m.messageId === row.messageId,
      );
      // Grant only rows still live and pending: a removed or receipted row
      // owes nothing, and granting it would open a dead intent.
      if (!node || !live || !isPendingDelivery(live)) continue;
      const bindingId = deliveryTargetOf(node)?.bindingId;
      // Without a bound seat there is no transport generation to fence
      // against, and no paste a grant could authorize: skip the row.
      if (bindingId === undefined) continue;
      // Pre-grant fence: only the seat's current generation may open a new
      // intent. An old generation's held row must never grant — its retry
      // would paste under a generation the ledger no longer tracks.
      const current = await this.currentSeatGeneration(bindingId);
      if (!this.active(generation)) return;
      if (current === undefined || current !== row.recipient.generation) {
        continue;
      }
      let granted = false;
      try {
        granted = await ledger.grantHeldAttempt({
          canvas,
          nodeId: row.recipient.seat.nodeId,
          messageId: row.messageId,
          generation: row.recipient.generation,
        });
      } catch {
        continue;
      }
      if (!granted) continue;
      // Post-grant fence: the seat may have cut generation while the grant
      // write was in flight. Release the drive hold only when the granted
      // generation is still current; the release carries it so the
      // composition can verify before touching the drive.
      const fresh = await this.currentSeatGeneration(bindingId);
      if (!this.active(generation)) return;
      if (fresh === undefined || fresh !== row.recipient.generation) continue;
      if (!releasedBindings.has(bindingId)) {
        releasedBindings.add(bindingId);
        this.releaseSeatHold?.(bindingId, row.recipient.generation);
      }
    }
  }

  /**
   * The seat's current transport generation. A missing or failed snapshot
   * cannot authorize a grant from a previously observed generation.
   */
  private async currentSeatGeneration(
    bindingId: string,
  ): Promise<string | undefined> {
    try {
      return (await this.transport?.seatDeliverySnapshot?.(bindingId))?.generationKey;
    } catch {
      return undefined;
    }
  }

  /**
   * Reset this canvas's retry backoff, then re-drive the canvas alone. The
   * canvas's bindings resolve from the document first.
   */
  private async resumeCanvasSweep(canvas: string): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active(generation)) return;
    await this.grantResumeRetries(canvas, generation);
    if (!this.active(generation)) return;
    try {
      const doc = await this.store?.readDoc(canvas, "scan");
      if (this.active(generation) && doc) {
        for (const node of doc.nodes) {
          const bindingId = deliveryTargetOf(node)?.bindingId;
          if (bindingId === undefined) continue;
          this.gateRefusalStreak.delete(bindingId);
          const timer = this.gateRetryTimers.get(bindingId);
          if (timer !== undefined) {
            this.timers.clear(timer);
            this.gateRetryTimers.delete(bindingId);
          }
        }
      }
    } catch {
      // Best-effort: the sweep below still re-validates against the doc.
    }
    if (!this.active(generation)) return;
    await this.retryRequestResponses(undefined, canvas);
    if (!this.active(generation)) return;
    await this.sweepAllCanvases(() => true, canvas);
  }

  /**
   * Process boot — deliver the durable backlog. Mail appended while a previous
   * process was alive (or while no process ran at all) has no attach/idle
   * event left to re-drive it; without this scan a restart silently strands
   * every pending message until an unrelated trigger happens to fire.
   */
  onBooted(): void {
    if (this.suspended) return;
    void this.retryRequestResponses();
    // Boot reconciliation runs once in startup composition BEFORE configure:
    // a delayed reconcile here could misclassify a CURRENT in-flight attempt
    // as a crashed intent. Delivery only ever reads attempt rows.
    void this.sweepAllCanvases(() => true);
  }

  /**
   * Re-drive queued request responses, optionally narrowed to one seat.
   *
   * The `bindingId` narrowing is a PRE-FILTER, not the authority. It used to
   * read the whole canvas — every sink's tasks, messages, requests, artifacts,
   * board and pad — once per pending entry, to answer `nodes.find(id)`. Two
   * things fix that without moving the freshness guarantee:
   *
   *  - the lookup is node-scoped, so it never builds the work projection;
   *  - it is resolved once per distinct target per pass, not once per pending
   *    item (several queued answers for one seat share one lookup).
   *
   * Freshness stays where it belongs: `attemptRequestResponse` re-resolves the
   * node from live authority immediately before it wakes a seat, so a pass
   * whose filter went stale can only skip work — it can never mint a process
   * against a node that has since moved or gone.
   */
  private async retryRequestResponses(
    bindingId?: string,
    onlyCanvas?: string,
  ): Promise<void> {
    const store = this.store;
    if (bindingId === undefined) {
      for (const [key, pending] of this.pendingRequestResponses) {
        if (onlyCanvas !== undefined && pending.canvas !== onlyCanvas) {
          continue;
        }
        await this.attemptRequestResponse(key, pending);
      }
      return;
    }
    if (!store) return;
    const bindingByTarget = new Map<string, string | undefined>();
    for (const [key, pending] of this.pendingRequestResponses) {
      const targetKey = `${pending.canvas}::${pending.actorNodeId}`;
      if (!bindingByTarget.has(targetKey)) {
        let resolved: string | undefined;
        try {
          const found = await store.readNodeStructure(
            pending.canvas,
            pending.actorNodeId,
          );
          resolved =
            found === undefined
              ? undefined
              : deliveryTargetOf(found.node)?.bindingId;
        } catch {
          resolved = undefined;
        }
        bindingByTarget.set(targetKey, resolved);
      }
      if (bindingByTarget.get(targetKey) !== bindingId) continue;
      await this.attemptRequestResponse(key, pending);
    }
  }

  private async attemptRequestResponse(
    key: string,
    pending: {
      readonly canvas: string;
      readonly actorNodeId: string;
      readonly requestId: string;
      readonly response: string;
    },
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active(generation) || this.inFlight.has(key)) return;
    const transport = this.transport;
    const store = this.store;
    if (!transport || !store) return;
    this.inFlight.add(key);
    try {
      // Fresh, node-scoped, immediately before the wake: this is the read that
      // guarantees a stale view never mints a process. It asks only structural
      // questions (node exists, seat binding, pause geography), so it must not
      // pay for the work projection.
      const found = await store.readNodeStructure(
        pending.canvas,
        pending.actorNodeId,
      );
      if (!this.active(generation) || !found) return;
      if (
        this.seatPausedLookup?.(
          pending.canvas,
          found.structure,
          pending.actorNodeId,
        )
      ) {
        return;
      }
      const target = deliveryTargetOf(found.node);
      if (!target) return;
      const woke = await this.wakeManagedSeat(
        transport,
        pending.canvas,
        pending.actorNodeId,
      );
      if (!woke) return;
      const gate = await this.evaluateSeatGate(target.bindingId);
      if (!gate.allow) return;
      const promptOptions = transport.wakeManagedSeat
        ? { ready: true }
        : undefined;
      // Same notify surface as mail: long responses summarize to a pointer.
      const raw = `[request resolved - ${pending.requestId}] ${pending.response}`;
      const payload =
        sanitizeDeliveryLine(raw).length > MESSAGE_PTY_FULL_BODY_MAX
          ? sanitizeDeliveryLine(
              `[request resolved - ${pending.requestId}] — junto msg list`,
            )
          : sanitizeDeliveryLine(raw);
      const outcome = await this.deliver(
        transport,
        target,
        payload,
        `request:${pending.requestId}`,
        promptOptions,
      );
      if (outcome.status === "submitted") this.pendingRequestResponses.delete(key);
    } catch {
      // Leave pending for the next idle/attach/resume lifecycle event.
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Full world read: reconcile the pending index against every canvas, and
   * deliver what `match` selects.
   *
   * This is the REBUILD, not the steady state. Boot and resume take it because
   * a fresh process holds no index at all; a narrowed pass takes it only when
   * the reconcile floor has elapsed, so a durable append that never announced
   * itself is still found. Every canvas read here re-seeds the index for that
   * canvas, which is what makes the next narrowed pass cost the delta.
   */
  private async sweepAllCanvases(
    match: (target: SurfaceDeliveryTarget) => boolean,
    onlyCanvas?: string,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active(generation)) return;
    const store = this.store;
    if (!store) return;
    // Stamped BEFORE the read: anything indexed from here on is newer than the
    // documents this pass sees, so the prune must not touch it.
    const startSeq = this.indexSeq;
    let names: ReadonlyArray<string>;
    try {
      names = await store.listCanvasNames();
    } catch {
      await this.retryPendingReadStamps(generation, match);
      return;
    }
    if (!this.active(generation)) return;
    // Only a read that saw every canvas may reset the floor — a partial world
    // is not a reconcile, and must not suppress the next one. A canvas-scoped
    // pass never resets it.
    let reconciled = true;
    for (const canvas of names) {
      if (!this.active(generation)) return;
      if (onlyCanvas !== undefined && canvas !== onlyCanvas) continue;
      let doc: CanvasDoc | undefined;
      try {
        doc = await store.readDoc(canvas, "scan");
      } catch {
        reconciled = false;
        continue;
      }
      if (!this.active(generation)) return;
      if (!doc) {
        reconciled = false;
        continue;
      }
      // Group pending by seat so wake can batch into one notify line.
      const groups = new Map<
        string,
        {
          readonly nodeId: string;
          readonly target: SurfaceDeliveryTarget;
          readonly messages: Message[];
        }
      >();
      const observed = new Map<string, Set<string>>();
      for (const pending of listPendingDeliveries(doc)) {
        let seen = observed.get(pending.nodeId);
        if (!seen) {
          seen = new Set<string>();
          observed.set(pending.nodeId, seen);
        }
        seen.add(pending.message.messageId);
        this.rememberPending(canvas, pending.nodeId, pending.message);
        if (!match(pending.target)) continue;
        const key = `${pending.nodeId}::${pending.target.bindingId}`;
        const existing = groups.get(key);
        if (existing) {
          existing.messages.push(pending.message);
        } else {
          groups.set(key, {
            nodeId: pending.nodeId,
            target: pending.target,
            messages: [pending.message],
          });
        }
      }
      this.reconcileCanvasIndex(canvas, observed, startSeq);
      for (const group of groups.values()) {
        if (!this.active(generation)) return;
        await this.deliverGroup(generation, canvas, group.nodeId, group.messages);
      }
    }
    if (reconciled && onlyCanvas === undefined) {
      this.lastReconcileAtMs = this.now();
    }
    await this.retryPendingReadStamps(generation, match, onlyCanvas);
  }

  /**
   * One seat transition — deliver exactly that seat's queued mail.
   *
   * Same shape as the narrowed `retryRequestResponses` pass: the pending set
   * is held in memory, so the pass costs one node-scoped routing lookup per
   * seat that actually holds mail (none at all when nothing is queued) instead
   * of listing every canvas, reading every document, walking every node, and
   * discarding all but one binding's worth.
   *
   * The index is a PRE-FILTER, never the authority. `attemptOne` /
   * `attemptBatch` re-read the document from authority before they touch a
   * transport, so a stale index entry can only cost a wasted lookup — it can
   * never paste a message that is no longer pending.
   */
  private async deliverForBinding(bindingId: string): Promise<void> {
    if (this.reconcileDue()) {
      await this.sweepAllCanvases((target) => target.bindingId === bindingId);
      return;
    }
    const generation = this.lifecycleGeneration;
    if (!this.active(generation)) return;
    const store = this.store;
    if (!store) return;
    for (const entry of [...this.pendingIndex.values()]) {
      if (!this.active(generation)) return;
      if (entry.messages.size === 0) continue;
      let found: MessageDeliveryNodeStructure | undefined;
      try {
        found = await store.readNodeStructure(entry.canvas, entry.nodeId);
      } catch {
        // Transient authority error — leave the mail queued for the next pass.
        continue;
      }
      if (!this.active(generation)) return;
      if (found === undefined) {
        // `undefined` is the durable "node is gone" answer, never a read error.
        this.forgetNode(entry.canvas, entry.nodeId);
        continue;
      }
      const target = deliveryTargetOf(found.node);
      if (!target || target.bindingId !== bindingId) continue;
      await this.deliverGroup(
        generation,
        entry.canvas,
        entry.nodeId,
        [...entry.messages.values()].map((held) => held.message),
      );
    }
    await this.retryPendingReadStamps(
      generation,
      (target) => target.bindingId === bindingId,
    );
  }

  /**
   * One seat's pending mail. Marker-less prompt-kind rows are explicit-only
   * and never attempted here — only prompt() attempts them, so creation
   * cannot race an automatic attempt; rows with a durable notice-fallback
   * marker rejoin as ordinary mail. Edge-map notices keep per-message
   * attemptOne (topology bounds); ordinary mail (including factory mail)
   * batches into one notify line on the same seat.
   */
  /**
   * Whether the ledger holds an operator-opened intent for this row: a
   * same-generation explicit-resume grant the sweep has not consumed yet.
   * A granted retry bypasses the turn budget (explicit authorization, like
   * prompt()) but still passes every other gate. Never throws: ledger
   * trouble fails closed to budgeted.
   */
  private async isGrantOpenForRetry(
    canvas: string,
    nodeId: string,
    messageId: string,
    generation: string | undefined,
  ): Promise<boolean> {
    if (generation === undefined) return false;
    try {
      const row = await this.attempts?.attempt?.({
        canvas,
        nodeId,
        messageId,
        generation,
      });
      return (
        (row?.attemptSeq ?? 0) > (row?.resolvedSeq ?? 0)
      );
    } catch {
      return false;
    }
  }

  /**
   * Durable notice fallback: an explicit-only prompt-kind row rejoins the
   * ordinary notice path once an explicit request persisted its marker.
   * Marker-less rows (or a marker-less store) stay explicit-only. Never
   * throws: ledger trouble fails closed to explicit-only.
   */
  private async hasNoticeFallback(
    canvas: string,
    nodeId: string,
    messageId: string,
  ): Promise<boolean> {
    try {
      return (
        (await this.attempts?.hasNoticeFallback?.({
          canvas,
          nodeId,
          messageId,
        })) ?? false
      );
    } catch {
      return false;
    }
  }

  private async deliverGroup(
    generation: number,
    canvas: string,
    nodeId: string,
    messages: ReadonlyArray<Message>,
  ): Promise<void> {
    const edgeMap: Message[] = [];
    const operatorPrompts: Message[] = [];
    const ordinary: Message[] = [];
    for (const message of messages) {
      if (message.metadata?.edgeMapChange === true) edgeMap.push(message);
      else if (isOperatorPromptRow(message)) operatorPrompts.push(message);
      else if (readMailExtension(message.metadata)?.mailKind === "prompt") {
        // Explicit-only — unless a durable fallback marker re-admitted it.
        if (
          await this.hasNoticeFallback(canvas, nodeId, message.messageId)
        ) {
          ordinary.push(message);
        }
      } else ordinary.push(message);
    }
    const latestFirst = sortMessagesNewestFirst(ordinary);
    if (latestFirst.length === 1) {
      await this.attemptOne(canvas, nodeId, latestFirst[0]!);
    } else if (latestFirst.length > 1) {
      await this.attemptBatch(canvas, nodeId, latestFirst);
    }
    for (const message of edgeMap) {
      if (!this.active(generation)) return;
      await this.attemptOne(canvas, nodeId, message);
    }
    for (const message of operatorPrompts) {
      if (!this.active(generation)) return;
      await this.attemptOne(canvas, nodeId, message);
    }
  }

  /**
   * Delivery already accepted, full-body read stamp still missing. Scan again
   * without listing the message as pending — never re-hit the PTY.
   */
  private async retryPendingReadStamps(
    generation: number,
    match: (target: SurfaceDeliveryTarget) => boolean,
    onlyCanvas?: string,
  ): Promise<void> {
    const store = this.store;
    if (!store || this.pendingReadStamps.size === 0) return;
    for (const [key, pending] of [...this.pendingReadStamps]) {
      if (!this.active(generation)) return;
      if (onlyCanvas !== undefined && pending.canvas !== onlyCanvas) continue;
      // Routing only — `attemptOne` re-reads the full document behind this and
      // is what decides anything about the message itself.
      let found: MessageDeliveryNodeStructure | undefined;
      try {
        found = await store.readNodeStructure(pending.canvas, pending.nodeId);
      } catch {
        continue;
      }
      if (!this.active(generation)) return;
      if (!found) {
        this.pendingReadStamps.delete(key);
        this.forgetNode(pending.canvas, pending.nodeId);
        continue;
      }
      const target = deliveryTargetOf(found.node);
      if (!target || !match(target)) continue;
      await this.attemptOne(pending.canvas, pending.nodeId, pending.message);
    }
  }

  /**
   * Product gate before PTY paste. Gate refusals do not burn transport
   * attempts and arm a timer retry so already-idle seats still receive mail.
   */
  private async evaluateSeatGate(
    bindingId: string,
  ): Promise<SeatDeliveryGateResult> {
    const transport = this.transport;
    if (!transport?.seatDeliverySnapshot) return { allow: true };
    let snap: SeatDeliverySnapshot | undefined;
    try {
      snap = await transport.seatDeliverySnapshot(bindingId);
    } catch {
      snap = undefined;
    }
    if (!snap) {
      // Starting/restarting — short retry, not permanent strand.
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_RETRY_MS);
      return { allow: false, reason: "unavailable" };
    }
    if (this.lastGenerationKey.get(bindingId) !== snap.generationKey) {
      this.lastGenerationKey.set(bindingId, snap.generationKey);
      // New generation is a real state change — start polling fresh.
      this.gateRefusalStreak.delete(bindingId);
    }
    return { allow: true, generationKey: snap.generationKey };
  }


  private async acceptDeliveryAndMaybeRead(
    store: MessageDeliveryStore,
    canvas: string,
    nodeId: string,
    message: Message,
  ): Promise<boolean> {
    const accepted = await store.acceptMessageDelivery(
      canvas,
      nodeId,
      message.messageId,
    );
    if (!accepted) return false;
    if (!ptyInjectMarksRead(message)) return true;
    return store.acceptMessageRead(canvas, nodeId, message.messageId);
  }

  private rememberPendingReadStamp(
    canvas: string,
    nodeId: string,
    message: Message,
  ): void {
    this.pendingReadStamps.set(flightKey(canvas, nodeId, message.messageId), {
      canvas,
      nodeId,
      message,
    });
  }

  private clearAttemptBookkeeping(key: string): void {
    this.transportAccepted.delete(key);
    this.transportUnresolved.delete(key);
    this.attemptedClaims.delete(key);
    this.transportAttempts.delete(key);
    this.wakeRetryCounts.delete(key);
    this.wakeRefusalLogged.delete(key);
  }

  /**
   * Delivery receipt already exists — stamp read only when a full-body inject
   * still lacks one. Never wake or paste.
   */
  private async stampReadIfNeeded(
    store: MessageDeliveryStore,
    canvas: string,
    nodeId: string,
    message: Message,
    live: Message | undefined,
  ): Promise<void> {
    const key = flightKey(canvas, nodeId, message.messageId);
    if (!live || !ptyInjectMarksRead(live)) {
      this.pendingReadStamps.delete(key);
      return;
    }
    if (await store.hasAcceptedMessageRead(canvas, nodeId, live.messageId)) {
      this.pendingReadStamps.delete(key);
      return;
    }
    const stamped = await store.acceptMessageRead(canvas, nodeId, live.messageId);
    if (stamped) this.pendingReadStamps.delete(key);
    else this.rememberPendingReadStamp(canvas, nodeId, message);
  }

  private async attemptOne(
    canvas: string,
    nodeId: string,
    message: Message,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active(generation)) return;
    const transport = this.transport;
    const store = this.store;
    if (!transport || !store) return;

    const key = flightKey(canvas, nodeId, message.messageId);
    if (!isPendingDelivery(message) && !this.pendingReadStamps.has(key)) return;
    if (this.inFlight.has(key)) return; // at-most-once under burst
    this.inFlight.add(key);

    try {
      // Durable delivery receipt stops paste. A missing full-body read stamp
      // is retried here without touching the transport.
      if (await store.hasAcceptedMessageDelivery(canvas, nodeId, message.messageId)) {
        let live: Message | undefined;
        let loaded = false;
        try {
          const doc = await store.readDoc(canvas, "attempt");
          live = doc?.nodes
            .find((n) => n.id === nodeId)
            ?.ether?.messages?.items.find((m) => m.messageId === message.messageId);
          loaded = true;
        } catch {
          live = undefined;
        }
        if (this.active(generation) && loaded) {
          await this.stampReadIfNeeded(store, canvas, nodeId, message, live);
        }
        this.clearAttemptBookkeeping(key);
        // Durable receipt exists — this message owes no further notify.
        this.forgetPending(canvas, nodeId, message.messageId);
        return;
      }
      if (!this.active(generation)) return;

      // Re-read before send: message may have been removed.
      const doc = await store.readDoc(canvas, "attempt");
      if (!this.active(generation)) return;
      if (!doc) return;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node) {
        // The document is authority: the node is gone, so is its queued mail.
        this.forgetNode(canvas, nodeId);
        return;
      }
      // Paused target: leave the message pending; resume re-drives it.
      if (this.seatPausedLookup?.(canvas, doc, nodeId)) return;
      const live = node.ether?.messages?.items.find((m) => m.messageId === message.messageId);
      if (!live) {
        // Message gone — drop the bounded re-drive mark so a re-appended
        // message with this id starts fresh (at-most-once is moot).
        this.attemptedClaims.delete(key);
        this.transportUnresolved.delete(key);
        this.forgetPending(canvas, nodeId, message.messageId);
        return;
      }
      if (isPendingDelivery(live) === false) {
        this.attemptedClaims.delete(key);
        this.transportUnresolved.delete(key);
        // Read or already delivered — off the pending index either way.
        this.forgetPending(canvas, nodeId, message.messageId);
        // Listed = handled. Do not paste, and do not mint a fake notify receipt.
        if (isMessageRead(live) && !isMessageDelivered(live)) return;
        // Projected metadata already shows delivered — still ensure durable receipt.
        if (!this.transportAccepted.has(key)) {
          const accepted = await this.acceptDeliveryAndMaybeRead(
            store,
            canvas,
            nodeId,
            live,
          );
          if (accepted) {
            this.pendingReadStamps.delete(key);
            this.transportAccepted.delete(key);
          } else if (
            ptyInjectMarksRead(live) &&
            (await store.hasAcceptedMessageDelivery(canvas, nodeId, live.messageId))
          ) {
            this.rememberPendingReadStamp(canvas, nodeId, message);
          }
        }
        return;
      }

      const target = deliveryTargetOf(node);
      if (!target) return;

      // Prompt-kind rows are explicit-only: the auto-notice queue never
      // takes them — unless an operatorPrompt flag or a durable
      // notice-fallback marker re-admitted this row. Operator prompts stay
      // immediate (full body as a turn). Notice fallback degrades to a
      // summary line and must not be used for the operator's body.
      // Skipped rows leave the pending index; the world (not the index)
      // re-derives them, so a later grant still finds them.
      const mailKindIsPrompt =
        readMailExtension(live.metadata)?.mailKind === "prompt";
      let noticeFallback = false;
      if (mailKindIsPrompt) {
        noticeFallback = await this.hasNoticeFallback(
          canvas,
          nodeId,
          live.messageId,
        );
        if (!noticeFallback && !isOperatorPromptRow(live)) {
          this.forgetPending(canvas, nodeId, live.messageId);
          return;
        }
      }

      // Same-generation uncertainty hold: a prior attempt wrote without
      // proof. No transport, no receipt — the stamp-only path below must
      // not launder it into a delivered receipt either.
      if (!(await this.checkUnresolvedHold(target.bindingId, key))) return;

      const woke = await this.wakeManagedSeat(
        transport,
        canvas,
        nodeId,
      );
      if (!woke) {
        // Refused wake: the message stays pending. Say so once, and arm a
        // bounded deferred re-attempt — a cold seat has no attach/idle event
        // coming, so without this the mail would park forever in silence.
        if (!this.wakeRefusalLogged.has(key)) {
          this.wakeRefusalLogged.add(key);
          console.error(
            `[delivery] wake refused — message ${message.messageId} for ${canvas}/${nodeId} stays pending (reason logged by [wake] above)`,
          );
        }
        this.scheduleWakeRetry(generation, canvas, nodeId, message, key);
        return;
      }
      this.wakeRefusalLogged.delete(key);

      // At-most-once: never re-hit the transport after a prior accept.
      if (!this.transportAccepted.has(key)) {
        if (!this.active(generation)) return;
        // Live duplicate fix — per-message transport bound (ALL messages):
        // a message whose transport attempts keep failing is parked after the
        // cap; only a receipt, removal, or resume re-arms it.
        const attempts = this.transportAttempts.get(key) ?? 0;
        if (attempts >= MessageDeliveryService.MAX_TRANSPORT_ATTEMPTS) {
          return;
        }
        // Seat liveness only. A seat with no live generation is not a
        // transport failure — do not burn attempts or edge-map claims (the
        // claim is recorded only after the gate allows).
        const gate = await this.evaluateSeatGate(target.bindingId);
        if (!gate.allow) return;

        // Edge-map notice law (bounded re-drive + stale re-validation):
        // AFTER the gate so a seat that is not up cannot burn the claim.
        let claimSetThisPass = false;
        if (live.metadata?.edgeMapChange === true) {
          const addedIds = edgeMapAddedIds(live);
          if (addedIds.length > 0) {
            if (
              addedIds.some((targetId) => !isConnectedTarget(doc, nodeId, targetId))
            ) {
              return; // stale claim — refuse; a later topology change re-validates
            }
            const signature = docTopologySignature(doc);
            const prior = this.attemptedClaims.get(key);
            if (prior !== undefined && prior.signature === signature) {
              return; // already attempted against this edge-map state — bounded
            }
            this.attemptedClaims.set(key, { signature });
            claimSetThisPass = true;
          }
        }

        const extension = readMailExtension(live.metadata);
        const policy: MailDeliveryPolicy =
          extension?.mailKind === "prompt" && !noticeFallback
            ? "immediate"
            : "notice";
        const promptOptions = transport.wakeManagedSeat
          ? { ready: true }
          : undefined;
        const seatGeneration = gate.generationKey;
        const prep = await this.prepareAttempt(
          canvas,
          nodeId,
          live.messageId,
          key,
          seatGeneration,
          policy,
        );
        if (prep === "ledgerDown" || prep === "held") return;
        let outcome: ManagedPromptOutcome | undefined;
        if (prep === "stampOnly") {
          // Acceptance evidence already durable: fall through to the
          // receipt stamp with no new write.
          outcome = this.stampedOnlyOutcome();
        } else {
          // Immediate prompts carry the full body under the server sender
          // envelope; ordinary notices keep the summary-plus-pointer shape
          // (a prompt's explicit notice fallback uses the notice builder).
          const payload =
            policy === "immediate"
              ? composeImmediatePromptPayload(live)
              : composeMessageDeliveryPayload(live);
          if (
            !(await this.markAttempt(
              canvas,
              nodeId,
              live.messageId,
              seatGeneration,
            ))
          ) {
            return;
          }
          this.transportAttempts.set(key, (this.transportAttempts.get(key) ?? 0) + 1);
          const writesBefore = transport.pasteWriteCount?.(target.bindingId);
          try {
            outcome = await this.deliver(
              transport,
              target,
              payload,
              live.messageId,
              promptOptions,
            );
          } finally {
          // A refusal that never touched the PTY (drive refused at a gate
          // race, or the transport threw/rejected before writing)
          // must not consume the bounded re-drive marks: nothing was pasted,
          // so there is nothing a re-drive could duplicate. The outcome's
          // own physical-write facts are authoritative; the envelope counter
          // is the fallback for transports that cannot report them. A
          // written attempt (paste without ack — the live 4x class) keeps
          // them, whatever the acknowledgement outcome.
          // The outcome's own physical-write facts are authoritative, but
          // a throw leaves no outcome at all: then only the envelope
          // counter can prove a clean refusal, and an absent counter keeps
          // the charge conservatively.
          const counterEqual =
            writesBefore !== undefined &&
            transport.pasteWriteCount?.(target.bindingId) === writesBefore;
          const wroteNothing =
            outcome !== undefined &&
            outcome.status === "refused" &&
            !outcome.wrotePhysicalBytes;
          if (
            (outcome === undefined && counterEqual) ||
            (wroteNothing &&
              (writesBefore === undefined || counterEqual))
          ) {
            if (claimSetThisPass) this.attemptedClaims.delete(key);
            const attempts = this.transportAttempts.get(key) ?? 0;
            if (attempts > 0) this.transportAttempts.set(key, attempts - 1);
          }
        }
          if (outcome === undefined) return;
          if (outcome.status !== "submitted") {
            // Unresolved stays receiptless and pending with the no-replay
            // marks below: neither transport nor receipt on the next idle —
            // only a new generation, an explicit resume batch, or operator
            // action authorizes another attempt. A clean pre-write refusal
            // sets no mark at all: nothing was pasted, so a re-drive cannot
            // duplicate, and the rolled-back attempt bounds stay retryable.
            await this.recordAttemptOutcome(
              canvas,
              nodeId,
              live.messageId,
              seatGeneration,
              outcome,
            );
            if (outcome.status === "unresolved") {
              this.transportAccepted.add(key);
              // Held with or without a ledger generation: without one the
              // hold releases only on resume, removal, or a newly observed
              // seat generation.
              this.transportUnresolved.set(key, seatGeneration ?? "");
            }
            if (
              outcome.status === "refused" &&
              !outcome.wrotePhysicalBytes &&
              this.isRetryableRefusal(outcome.reason)
            ) {
              this.scheduleGateRetry(target.bindingId, MESSAGE_DELIVERY_RETRY_MS);
            }
            return;
          }
          await this.recordAttemptOutcome(
            canvas,
            nodeId,
            live.messageId,
            seatGeneration,
            outcome,
          );
          this.transportAccepted.add(key);
        }
      }

      const accepted = await this.acceptDeliveryAndMaybeRead(
        store,
        canvas,
        nodeId,
        live,
      );
      if (accepted) {
        this.pendingReadStamps.delete(key);
        this.clearAttemptBookkeeping(key);
        this.forgetPending(canvas, nodeId, live.messageId);
      } else {
        if (
          ptyInjectMarksRead(live) &&
          (await store.hasAcceptedMessageDelivery(canvas, nodeId, live.messageId))
        ) {
          this.rememberPendingReadStamp(canvas, nodeId, message);
        }
        // Accept fail: keep transportAccepted so attach/idle only re-receipts.
        // Make the failure LOUD — a silent missing receipt is what let the
        // same message re-paste in production.
        console.error(
          `[delivery] receipt stamp FAILED for ${canvas}/${nodeId}/${live.messageId} ` +
            `(transport accepted; message stays pending; re-paste suppressed by transportAccepted)`,
        );
      }
    } catch {
      // Best-effort: leave pending; inFlight cleared so idle/attach can retry.
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Deliver several ordinary pending messages as ONE notify line, then stamp
   * every message on success. Gate/wake failure leaves all pending.
   * inFlight / transportAccepted use a per-seat batch key (not
   * content-addressed message sets), a batch reserves each member's message
   * key so an individual notify cannot double-paste it, and transport
   * attempts are charged to each member — the same per-message bound
   * attemptOne enforces — so a member parked after its budget stays out of
   * later payloads while fresh mail on the seat still batches.
   */
  private async attemptBatch(
    canvas: string,
    nodeId: string,
    messages: ReadonlyArray<Message>,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active(generation) || messages.length === 0) return;
    const transport = this.transport;
    const store = this.store;
    if (!transport || !store) return;

    // Per-seat key — stable across concurrent scans with different message sets.
    const batchKey = flightKey(canvas, nodeId, "__batch__");
    if (this.inFlight.has(batchKey)) return;
    this.inFlight.add(batchKey);
    const reservedMessageKeys = new Set<string>();
    const batchTransportAccepted = this.transportAccepted.has(batchKey);

    try {
      // Drop already-receipted messages; if nothing left, done.
      const pending: Message[] = [];
      for (const message of messages) {
        if (!isPendingDelivery(message)) {
          this.forgetPending(canvas, nodeId, message.messageId);
          continue;
        }
        if (await store.hasAcceptedMessageDelivery(canvas, nodeId, message.messageId)) {
          this.forgetPending(canvas, nodeId, message.messageId);
          continue;
        }
        pending.push(message);
      }
      if (!this.active(generation) || pending.length === 0) return;
      // A lone survivor may be the failed member of an accepted batch. Keep it
      // on this path so the seat's batch marker settles from the document;
      // attemptOne alone would stamp the message and strand the marker.
      if (pending.length === 1 && !batchTransportAccepted) {
        await this.attemptOne(canvas, nodeId, pending[0]!);
        return;
      }

      const doc = await store.readDoc(canvas, "batch");
      if (!this.active(generation) || !doc) return;
      if (this.seatPausedLookup?.(canvas, doc, nodeId)) return;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node) {
        this.forgetNode(canvas, nodeId);
        return;
      }
      const target = deliveryTargetOf(node);
      if (!target) return;

      // Re-check each message still lives on the node as pending.
      const liveItems = node.ether?.messages?.items ?? [];
      const livePending = pending.filter((m) => {
        const live = liveItems.find((item) => item.messageId === m.messageId);
        if (live !== undefined && isPendingDelivery(live)) return true;
        // Gone or already handled — off the index on document evidence.
        this.forgetPending(canvas, nodeId, m.messageId);
        return false;
      });

      // Reserve each batch member before the next await. An individual
      // notify can already be in flight for one of these messages while a
      // boot/resume sweep reads the same backlog. Leave that message to its
      // individual owner; only the unclaimed remainder may be batched.
      const acceptedMembers = batchTransportAccepted
        ? this.acceptedBatchMembers.get(batchKey)
        : undefined;
      const individuallyOwned: Message[] = [];
      const unclaimed: Message[] = [];
      for (const message of livePending) {
        const key = flightKey(canvas, nodeId, message.messageId);
        if (this.inFlight.has(key)) continue;
        // Individually held uncertainty never joins a fresh batch payload.
        if (this.transportUnresolved.has(key)) continue;
        // Members of the accepted batch are settled below from the document.
        if (acceptedMembers?.has(message.messageId)) continue;
        if (this.transportAccepted.has(key)) {
          // An individual transport can have accepted while its durable
          // receipt is still pending. Let attemptOne stamp that message; it
          // must never be folded into a new batch and sent again.
          individuallyOwned.push(message);
          continue;
        }
        // Per-message transport bound: a parked member stays pending and out
        // of the payload until a receipt, removal, or resume re-arms it.
        if (
          (this.transportAttempts.get(key) ?? 0) >=
          MessageDeliveryService.MAX_TRANSPORT_ATTEMPTS
        ) {
          continue;
        }
        this.inFlight.add(key);
        reservedMessageKeys.add(key);
        unclaimed.push(message);
      }

      if (batchTransportAccepted) {
        // Stamp-only recovery: transport already accepted this seat's batch
        // once. Settle its members from the document and the receipt store —
        // not from what this pass happened to carry — so a member stamped
        // through attemptOne, or removed from the node, releases the marker.
        const anyOpen = await this.settleAcceptedBatch(
          store,
          canvas,
          nodeId,
          batchKey,
          liveItems,
          reservedMessageKeys,
        );
        if (!this.active(generation)) return;
        // A single message never needs the batch slot; a fresh payload does.
        // Held mail has no seat transition of its own to wait on, so re-poll.
        if (anyOpen && unclaimed.length > 1) {
          this.scheduleGateRetry(target.bindingId, MESSAGE_DELIVERY_RETRY_MS);
          return;
        }
      }

      for (const message of individuallyOwned) {
        await this.attemptOne(canvas, nodeId, message);
      }
      if (!this.active(generation) || unclaimed.length === 0) return;
      if (unclaimed.length === 1) {
        const only = unclaimed[0]!;
        const key = flightKey(canvas, nodeId, only.messageId);
        reservedMessageKeys.delete(key);
        this.inFlight.delete(key);
        await this.attemptOne(canvas, nodeId, only);
        return;
      }

      const woke = await this.wakeManagedSeat(transport, canvas, nodeId);
      if (!woke) {
        // Arm wake retry on the first message so the batch has a future trigger.
        const first = unclaimed[0]!;
        const key = flightKey(canvas, nodeId, first.messageId);
        if (!this.wakeRefusalLogged.has(key)) {
          this.wakeRefusalLogged.add(key);
          console.error(
            `[delivery] wake refused — batch of ${String(unclaimed.length)} for ${canvas}/${nodeId} stays pending`,
          );
        }
        this.scheduleWakeRetry(generation, canvas, nodeId, first, key);
        return;
      }
      if (!this.active(generation)) return;

      const gate = await this.evaluateSeatGate(target.bindingId);
      if (!gate.allow) return;

      const promptOptions = transport.wakeManagedSeat
        ? { ready: true }
        : undefined;
      const seatGeneration = gate.generationKey;

      // Durable membership before any member transport: atomic commit,
      // then partition out held (same-generation uncertainty) and
      // already-accepted members so neither joins a fresh payload.
      let members = unclaimed;
      if (seatGeneration !== undefined && this.attempts) {
        let priors: ReadonlyArray<DeliveryAttempt> = [];
        try {
          priors = await this.attempts.enqueueBatch({
            canvas,
            nodeId,
            batchId: batchKey,
            members: unclaimed.map((message) => ({
              messageId: message.messageId,
              generation: seatGeneration,
              policy: "notice" as const,
            })),
          });
        } catch {
          // Ledger write failed: fail closed without touching the PTY.
          return;
        }
        const priorById = new Map(priors.map((prior) => [prior.messageId, prior]));
        const transportable: Message[] = [];
        const stampNow: Message[] = [];
        for (const message of unclaimed) {
          const key = flightKey(canvas, nodeId, message.messageId);
          const prior = priorById.get(message.messageId);
          if (
            prior?.facts.unresolvedAt !== undefined &&
            prior.facts.notifiedAt === undefined
          ) {
            this.transportUnresolved.set(key, seatGeneration);
            this.transportAccepted.add(key);
            continue;
          }
          if (prior?.facts.notifiedAt === undefined) {
            let notifiedElsewhere = false;
            try {
              notifiedElsewhere =
                await this.attempts.hasNotifiedAcrossGenerations({
                  canvas,
                  nodeId,
                  messageId: message.messageId,
                });
            } catch {
              return;
            }
            if (!notifiedElsewhere) {
              transportable.push(message);
              continue;
            }
          }
          stampNow.push(message);
        }
        // Already-accepted members stamp individually — never folded into
        // a fresh payload and sent again.
        for (const message of stampNow) {
          const key = flightKey(canvas, nodeId, message.messageId);
          this.transportAccepted.add(key);
          const accepted = await this.acceptDeliveryAndMaybeRead(
            store,
            canvas,
            nodeId,
            message,
          );
          if (accepted) {
            this.pendingReadStamps.delete(key);
            this.clearAttemptBookkeeping(key);
            this.forgetPending(canvas, nodeId, message.messageId);
          }
        }
        members = transportable;
        if (members.length === 0) return;
      }
      const memberKeys = members.map((message) =>
        flightKey(canvas, nodeId, message.messageId),
      );
      for (const message of members) {
        if (
          !(await this.markAttempt(
            canvas,
            nodeId,
            message.messageId,
            seatGeneration,
          ))
        ) {
          return;
        }
      }
      const payload = composeMessageDeliverySummary(
        sortMessagesNewestFirst(members),
      );
      for (const key of memberKeys) {
        this.transportAttempts.set(key, (this.transportAttempts.get(key) ?? 0) + 1);
      }
      const writesBefore = transport.pasteWriteCount?.(target.bindingId);
      let outcome: ManagedPromptOutcome | undefined;
      try {
        outcome = await this.deliver(
          transport,
          target,
          payload,
          batchKey,
          promptOptions,
        );
      } finally {
        // Same law as attemptOne, including transport throws/rejections: a
        // refusal that never touched the PTY hands every member its attempt
        // back. A paste without acceptance keeps the charge and stays pending.
        const counterEqual =
          writesBefore !== undefined &&
          transport.pasteWriteCount?.(target.bindingId) === writesBefore;
        const wroteNothing =
          outcome !== undefined &&
          outcome.status === "refused" &&
          !outcome.wrotePhysicalBytes;
        if (
          (outcome === undefined && counterEqual) ||
          (wroteNothing &&
            (writesBefore === undefined || counterEqual))
        ) {
          for (const key of memberKeys) {
            const attempts = this.transportAttempts.get(key) ?? 0;
            if (attempts > 0) this.transportAttempts.set(key, attempts - 1);
          }
        }
      }
      if (outcome === undefined) return;
      if (outcome.status !== "submitted") {
        for (const message of members) {
          await this.recordAttemptOutcome(
            canvas,
            nodeId,
            message.messageId,
            seatGeneration,
            outcome,
          );
          if (outcome.status === "unresolved") {
            const memberKey = flightKey(canvas, nodeId, message.messageId);
            this.transportAccepted.add(memberKey);
            this.transportUnresolved.set(memberKey, seatGeneration ?? "");
          }
        }
        if (
          outcome.status === "refused" &&
          !outcome.wrotePhysicalBytes &&
          outcome.reason !== undefined &&
          this.isRetryableRefusal(outcome.reason)
        ) {
          this.scheduleGateRetry(target.bindingId, MESSAGE_DELIVERY_RETRY_MS);
        }
        return;
      }
      for (const message of members) {
        await this.recordAttemptOutcome(
          canvas,
          nodeId,
          message.messageId,
          seatGeneration,
          outcome,
        );
      }
      // Marker plus every member key land before the first await, so no
      // later pass can re-send any part of the accepted payload.
      this.transportAccepted.add(batchKey);
      this.acceptedBatchMembers.set(
        batchKey,
        new Set(members.map((message) => message.messageId)),
      );
      for (const key of memberKeys) this.transportAccepted.add(key);

      await this.settleAcceptedBatch(
        store,
        canvas,
        nodeId,
        batchKey,
        liveItems,
        reservedMessageKeys,
      );
    } catch {
      // Leave pending for idle/attach retry.
    } finally {
      for (const key of reservedMessageKeys) this.inFlight.delete(key);
      this.inFlight.delete(batchKey);
    }
  }

  /**
   * Stamp the receipts an accepted batch still owes, judged from the document
   * and the receipt store rather than from the messages one pass carried. A
   * member removed from the node, already receipted, or receipted elsewhere
   * owes nothing. The marker clears once no member is pending without a
   * durable receipt; a member an individual attempt currently owns is left
   * to that owner (its own transportAccepted key keeps it from re-pasting).
   *
   * Returns true while a member's receipt stamp is still failing.
   */
  private async settleAcceptedBatch(
    store: MessageDeliveryStore,
    canvas: string,
    nodeId: string,
    batchKey: string,
    liveItems: ReadonlyArray<Message>,
    reservedMessageKeys: Set<string>,
  ): Promise<boolean> {
    const members = this.acceptedBatchMembers.get(batchKey);
    if (!members) {
      // The membership is process-local and should always accompany the
      // batch marker. Fail closed if that invariant is ever broken.
      this.transportAccepted.delete(batchKey);
      return false;
    }
    let anyOpen = false;
    for (const messageId of members) {
      const key = flightKey(canvas, nodeId, messageId);
      const live = liveItems.find((item) => item.messageId === messageId);
      if (live === undefined || !isPendingDelivery(live)) {
        // Gone or already handled on document evidence — owes nothing.
        this.clearAttemptBookkeeping(key);
        this.forgetPending(canvas, nodeId, messageId);
        continue;
      }
      if (this.inFlight.has(key) && !reservedMessageKeys.has(key)) continue;
      if (!reservedMessageKeys.has(key)) {
        this.inFlight.add(key);
        reservedMessageKeys.add(key);
      }
      const accepted =
        (await store.hasAcceptedMessageDelivery(canvas, nodeId, messageId)) ||
        (await store.acceptMessageDelivery(canvas, nodeId, messageId));
      if (accepted) {
        this.clearAttemptBookkeeping(key);
        this.forgetPending(canvas, nodeId, messageId);
        continue;
      }
      anyOpen = true;
      console.error(
        `[delivery] receipt stamp FAILED for ${canvas}/${nodeId}/${messageId} ` +
          `(batch transport accepted; re-paste suppressed by transportAccepted)`,
      );
    }
    if (!anyOpen) {
      this.transportAccepted.delete(batchKey);
      this.acceptedBatchMembers.delete(batchKey);
    }
    return anyOpen;
  }

  private async deliver(
    transport: MessageDeliveryTransport,
    target: SurfaceDeliveryTarget,
    payload: string,
    messageId: string,
    options?: ManagedTerminalPromptOptions,
  ): Promise<ManagedPromptOutcome> {
    // Managed drive (paste+CR) preferred; raw paste only for geography shells.
    if (transport.sendManagedTerminalPrompt) {
      // Mail is never gated on what the agent is doing: the drive writes into
      // an idle or a working seat, and the harness queues or steers it.
      return transport.sendManagedTerminalPrompt(target.bindingId, payload, {
        ...options,
        whileWorking: true,
      });
    }
    const ok =
      transport.sendTerminalPaste?.(target.bindingId, payload, messageId) ?? false;
    // Raw-paste shells have no drive counter or generation tracking: the
    // boolean acceptance is the whole fact, synthesized with zero evidence.
    // The durable attempt identity still uses the seat generation string.
    return ok
      ? {
          status: "submitted",
          bindingGeneration: 0,
          writesBefore: 0,
          writesAfter: 0,
          pasteWrites: 0,
          wrotePhysicalBytes: true,
        }
      : {
          status: "refused",
          reason: "not-ready",
          bindingGeneration: 0,
          writesBefore: 0,
          writesAfter: 0,
          pasteWrites: 0,
          wrotePhysicalBytes: false,
        };
  }

  /**
   * Record one transport outcome against the durable attempt ledger, when the
   * ledger is configured and the gate observed a seat generation. Mapping:
   * submitted to notifiedAt, written-unresolved to unresolvedAt, pre-write
   * refusal to refusedAt plus the closed reason. Lifecycle cuts record
   * nothing and leave the message pending.
   */
  private async recordAttemptOutcome(
    canvas: string,
    nodeId: string,
    messageId: string,
    generation: string | undefined,
    outcome: ManagedPromptOutcome,
  ): Promise<void> {
    const ledger = this.attempts;
    if (!ledger || generation === undefined) return;
    const at = new Date(this.now()).toISOString();
    const write: MailWriteEvidence = {
      writesBefore: outcome.writesBefore,
      writesAfter: outcome.writesAfter,
      at,
    };
    try {
      if (outcome.status === "submitted") {
        await ledger.recordAttempt({
          canvas,
          nodeId,
          messageId,
          generation,
          set: { notifiedAt: at },
          write,
        });
      } else if (outcome.status === "unresolved") {
        await ledger.recordAttempt({
          canvas,
          nodeId,
          messageId,
          generation,
          set: { unresolvedAt: at },
          write,
        });
        console.error(
          `[delivery] written-unresolved — ${canvas}/${nodeId}/${messageId} ` +
            `generation ${generation} reason ${outcome.reason} ` +
            `(same generation will not replay)`,
        );
      } else {
        const refusedReason = mailAttemptReasonOfRefusal(outcome.reason);
        if (refusedReason === undefined) return;
        await ledger.recordAttempt({
          canvas,
          nodeId,
          messageId,
          generation,
          set: { refusedAt: at, refusedReason },
          write,
        });
      }
    } catch {
      // Ledger write failed after transport: the message stays pending and
      // the in-memory no-replay marks below still suppress a same-generation
      // re-paste. Make the gap loud — a silent missing fact is what let the
      // same message re-paste in production.
      console.error(
        `[delivery] attempt record FAILED for ${canvas}/${nodeId}/${messageId} ` +
          `(outcome ${outcome.status}; message stays pending; re-paste suppressed in-process)`,
      );
    }
  }

  /**
   * A refusal for an attempt that never reached the drive: zero physical
   * facts, generation untracked. Used by the explicit prompt path for
   * pre-transport refusals (wake/gate/ledger/bound) so every return carries
   * the full outcome shape.
   */
  private refusedWithoutWrite(
    reason: ManagedPromptRefusalReason,
  ): ManagedPromptOutcome {
    return {
      status: "refused",
      reason,
      bindingGeneration: 0,
      writesBefore: 0,
      writesAfter: 0,
      pasteWrites: 0,
      wrotePhysicalBytes: false,
    };
  }

  /**
   * Same-generation uncertainty hold. Returns true when clear to attempt:
   * no hold, or a new seat generation released it (releasing also drops the
   * no-replay mark so the fresh attempt can paste). A held key consults the
   * gate once for a fresh generation read; anything else leaves it held —
   * no transport, no receipt.
   */
  private async checkUnresolvedHold(
    bindingId: string,
    key: string,
  ): Promise<boolean> {
    const heldGeneration = this.transportUnresolved.get(key);
    if (heldGeneration === undefined) return true;
    const holdGate = await this.evaluateSeatGate(bindingId);
    if (!holdGate.allow) return false;
    const currentGeneration = this.lastGenerationKey.get(bindingId);
    if (
      currentGeneration === undefined ||
      currentGeneration === heldGeneration
    ) {
      return false;
    }
    this.transportUnresolved.delete(key);
    this.transportAccepted.delete(key);
    return true;
  }

  /**
   * Durable pre-transport gate for one attempt. Enqueues before any write
   * (fail-closed on ledger failure), then reads back the row: a
   * same-generation uncertainty without acceptance holds (no transport, no
   * receipt), a same- or cross-generation acceptance stamps only (never a
   * second paste). Returns proceed when this call may attempt transport.
   */
  private async prepareAttempt(
    canvas: string,
    nodeId: string,
    messageId: string,
    key: string,
    generation: string | undefined,
    policy: MailDeliveryPolicy,
  ): Promise<"proceed" | "held" | "stampOnly" | "ledgerDown"> {
    const ledger = this.attempts;
    if (!ledger || generation === undefined) return "proceed";
    let prior: DeliveryAttempt | undefined;
    try {
      prior = await ledger.enqueueAttempt({
        canvas,
        nodeId,
        messageId,
        generation,
        policy,
      });
    } catch {
      return "ledgerDown";
    }
    // Same-generation uncertainty holds — unless an operator grant opened a
    // fresh intent (attemptSeq > resolvedSeq) after the uncertainty was
    // recorded. Rows read through older doubles carry no seqs and hold, the
    // pre-grant behavior.
    const grantOpen =
      prior.attemptSeq !== undefined &&
      prior.resolvedSeq !== undefined &&
      prior.attemptSeq > prior.resolvedSeq;
    if (
      prior.facts.unresolvedAt !== undefined &&
      prior.facts.notifiedAt === undefined &&
      !grantOpen
    ) {
      this.transportUnresolved.set(key, generation);
      this.transportAccepted.add(key);
      return "held";
    }
    if (prior.facts.notifiedAt !== undefined) {
      this.transportAccepted.add(key);
      return "stampOnly";
    }
    let notifiedElsewhere = false;
    try {
      notifiedElsewhere = await ledger.hasNotifiedAcrossGenerations({
        canvas,
        nodeId,
        messageId,
      });
    } catch {
      return "ledgerDown";
    }
    if (notifiedElsewhere) {
      this.transportAccepted.add(key);
      return "stampOnly";
    }
    return "proceed";
  }

  /**
   * Stamp the attempted_at intent witness immediately before the physical
   * write. False (ledger failure) fails the attempt closed: no transport
   * without its intent row.
   */
  private async markAttempt(
    canvas: string,
    nodeId: string,
    messageId: string,
    generation: string | undefined,
  ): Promise<boolean> {
    const ledger = this.attempts;
    if (!ledger || generation === undefined) return true;
    try {
      await ledger.markAttempted({ canvas, nodeId, messageId, generation });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synthesized submitted outcome for the stamp-only path: acceptance
   * evidence is already durable, so no new write happened in this call.
   */
  private stampedOnlyOutcome(): ManagedPromptOutcome {
    return {
      status: "submitted",
      bindingGeneration: 0,
      writesBefore: 0,
      writesAfter: 0,
      pasteWrites: 0,
      wrotePhysicalBytes: false,
    };
  }

  /** Pre-write refusals worth a bounded gate re-drive (a wait may clear them). */
  private isRetryableRefusal(reason: ManagedPromptRefusalReason): boolean {
    return (
      reason === "seat-busy" ||
      reason === "composer-not-empty" ||
      reason === "composer-unreadable" ||
      reason === "operator-active" ||
      reason === "not-ready" ||
      reason === "queue-timeout"
    );
  }

  private async wakeManagedSeat(
    transport: MessageDeliveryTransport,
    canvas: string,
    nodeId: string,
  ): Promise<boolean> {
    if (!transport.wakeManagedSeat) return true;
    try {
      return await transport.wakeManagedSeat(canvas, nodeId);
    } catch {
      return false;
    }
  }

  /**
   * One deferred re-attempt per pending message at a time, doubling delay,
   * bounded count. Delays step past the seat's automatic-restart backoff so a
   * crashed seat gets its budgeted restarts without an operator trigger.
   */
  private scheduleWakeRetry(
    generation: number,
    canvas: string,
    nodeId: string,
    message: Message,
    key: string,
  ): void {
    if (!this.active(generation)) return;
    if (this.wakeRetryTimers.has(key)) return;
    const spent = this.wakeRetryCounts.get(key) ?? 0;
    if (spent >= MessageDeliveryService.WAKE_RETRY_MAX) return;
    this.wakeRetryCounts.set(key, spent + 1);
    const delay = MessageDeliveryService.WAKE_RETRY_BASE_MS * 2 ** spent;
    const handle = this.timers.set(() => {
      this.wakeRetryTimers.delete(key);
      if (!this.active(generation)) return;
      void this.attemptOne(canvas, nodeId, message);
    }, delay);
    this.wakeRetryTimers.set(key, handle);
  }
}

/** Process-wide singleton — configured once at app boot; tests call resetForTest. */
export const messageDelivery = new MessageDeliveryService();
