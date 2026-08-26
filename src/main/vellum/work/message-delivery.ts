// Message delivery — one-way nudge from ether.messages onto live transports.
// Actor targets come from kind-discriminated surfaces (managed terminal seats
// and raw geography shells). Geography holds no inbox, so a raw shell is not
// a delivery target. No delivery daemon, no retry queue, no polling.
//
// Durable stop condition is work_delivery_receipts (delivery.accepted), not a
// canvas metadata stamp — work overlays are stripped on authorial write.

import type { CanvasDoc, CanvasNode, Message } from "@shared/canvas";
import {
  composeMessageDeliveryPayload,
  composeMessageDeliverySummary,
  deliveryTargetOf,
  isFactoryMailMessage,
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

/**
 * Quiet time after a generation first becomes idle before mail may paste.
 * Prevents open-to-continue from racing the load/resume paint with a dump.
 */
export const MESSAGE_DELIVERY_SETTLE_MS = 1_500;

/**
 * Ceiling for the backed-off gate re-poll. Defense in depth only: the cadence
 * was never the cost, the per-attempt world read was. Every refusal reason
 * that backs off here also has a real state-change trigger
 * (`onManagedTerminalIdle` / `onTerminalAttached` / `onResumed`), so the
 * ceiling bounds the worst case where NOTHING changes — never the normal case.
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
/** Deadline retries may be spread later, never earlier — the settle is a floor. */
const GATE_DEADLINE_SPREAD_MS = 150;

/**
 * Why a gate retry is being armed.
 *
 * `deadline` is a wait for a known instant (the settle point). It must fire at
 * that instant, so it never backs off — only a small forward spread.
 * `poll` is a re-ask of a condition with no known clearing time (busy seat,
 * seat not up, operator typing). Repeated polls back off.
 */
type GateRetryKind = "deadline" | "poll";

export type SeatDeliveryGateResult =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: "not-idle" | "not-settled" | "operator-draft" | "unavailable";
    };

export type MessageDeliveryTransport = {
  /** Start a local lazy managed seat before the first delivery attempt. */
  readonly wakeManagedSeat?: (
    canvas: string,
    nodeId: string,
  ) => boolean | Promise<boolean>;
  /** Paste without submitting (raw geography shells only). */
  readonly sendTerminalPaste?: (bindingId: string, text: string, messageId: string) => boolean;
  /**
   * Managed-terminal drive: paste+CR into an agent seat PTY, idle-gated by
   * default. Explicit factory mail may request one busy-turn interrupt.
   * Returns true only after the managed seat acknowledges turn-start.
   */
  readonly sendManagedTerminalPrompt?: (
    bindingId: string,
    text: string,
    options?: ManagedTerminalPromptOptions,
  ) => Promise<boolean>;
  /**
   * Live seat snapshot for the product delivery gate. Absent → allow
   * (unit tests without a host). Operator draft must never be overwritten;
   * settle waits MESSAGE_DELIVERY_SETTLE_MS after first idle for the epoch.
   */
  readonly seatDeliverySnapshot?: (
    bindingId: string,
  ) =>
    | {
        readonly idle: boolean;
        readonly generationKey: string;
        readonly operatorDraft: boolean;
      }
    | undefined
    | Promise<
        | {
            readonly idle: boolean;
            readonly generationKey: string;
            readonly operatorDraft: boolean;
          }
        | undefined
      >;
};

export type ManagedTerminalPromptOptions = {
  /** Allow the drive to retain a prompt while a freshly-woken seat reaches idle. */
  readonly ready?: boolean;
  /** Interrupt one active turn before the mailbox prompt is queued. */
  readonly interruptIfBusy?: boolean;
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
  /**
   * Per generationKey: first time we observed idle for this generation
   * (set when gate is consulted and seat is idle). Cleared on generation flip.
   */
  private readonly idleSinceByGeneration = new Map<string, number>();
  private readonly lastGenerationKey = new Map<string, string>();
  /**
   * Deferred re-scan for not-settled / unavailable / operator-draft so an
   * already-idle seat (no further idle transition) still receives mail.
   * Keyed by bindingId — one timer per seat.
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
  private now: MessageDeliveryClock = () => Date.now();
  private suspended = false;
  private lifecycleGeneration = 0;

  private seatPausedLookup: ((canvas: string, doc: CanvasDoc, nodeId: string) => boolean) | undefined;

  configure(input: {
    readonly transport: MessageDeliveryTransport;
    readonly store: MessageDeliveryStore;
    readonly now?: MessageDeliveryClock;
    /** Pause plane: a paused target keeps its messages pending (delivered on resume). */
    readonly seatPaused?: (canvas: string, doc: CanvasDoc, nodeId: string) => boolean;
    readonly timers?: MessageDeliveryTimers;
    /** Jitter seam — injectable so retry spread is deterministic in tests. */
    readonly random?: () => number;
  }): void {
    if (this.suspended) return;
    this.transport = input.transport;
    this.store = input.store;
    if (input.now) this.now = input.now;
    this.seatPausedLookup = input.seatPaused;
    if (input.timers) this.timers = input.timers;
    if (input.random) this.random = input.random;
  }

  /** Test seam — drop all in-flight marks and deps. */
  resetForTest(): void {
    this.lifecycleGeneration += 1;
    this.inFlight.clear();
    this.transportAccepted.clear();
    this.pendingReadStamps.clear();
    this.transportAttempts.clear();
    this.attemptedClaims.clear();
    this.pendingRequestResponses.clear();
    this.clearWakeRetries();
    this.wakeRefusalLogged.clear();
    this.idleSinceByGeneration.clear();
    this.lastGenerationKey.clear();
    this.clearGateRetries();
    this.clearPendingIndex();
    this.transport = undefined;
    this.store = undefined;
    this.now = () => Date.now();
    this.seatPausedLookup = undefined;
    this.timers = defaultTimers;
    this.random = Math.random;
    this.suspended = false;
  }

  /**
   * Monotonically stop product-driven delivery for this process.
   *
   * Pending messages remain durable and unstamped for a later licensed
   * process. Already accepted transport writes may finish their delivery
   * stamp, but no attach/idle/resume scan may reach a PTY after this cut.
   */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.lifecycleGeneration += 1;
    this.transport = undefined;
    this.store = undefined;
    this.seatPausedLookup = undefined;
    this.inFlight.clear();
    this.transportAccepted.clear();
    this.pendingReadStamps.clear();
    this.transportAttempts.clear();
    this.attemptedClaims.clear();
    this.pendingRequestResponses.clear();
    this.clearWakeRetries();
    this.wakeRefusalLogged.clear();
    this.idleSinceByGeneration.clear();
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
   * Delay for the next gate re-drive.
   *
   * `deadline` — the settle point is a known instant, so it fires on time and
   * only spreads FORWARD by a sub-tick amount; pulling it earlier would break
   * the settle guarantee.
   * `poll` — nothing says when the condition clears, so consecutive refusals
   * double the wait up to the ceiling. Jitter is symmetric so a floor of seats
   * refusing together stops landing on one tick (and one block).
   */
  private gateRetryDelay(
    kind: GateRetryKind,
    bindingId: string,
    requestedMs: number,
  ): number {
    if (kind === "deadline") {
      return Math.max(10, requestedMs + this.random() * GATE_DEADLINE_SPREAD_MS);
    }
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
   * Re-drive one binding after a gate refusal without waiting for a seat-state
   * transition (already-idle seats never re-fire onManagedTerminalIdle).
   */
  private scheduleGateRetry(
    bindingId: string,
    delayMs: number,
    kind: GateRetryKind,
  ): void {
    if (this.gateRetryTimers.has(bindingId)) return;
    const generation = this.lifecycleGeneration;
    const handle = this.timers.set(() => {
      this.gateRetryTimers.delete(bindingId);
      if (!this.active(generation)) return;
      void this.deliverForBinding(bindingId);
      // Request-response shares the seat gate; re-drive those too.
      void this.retryRequestResponses(bindingId);
    }, this.gateRetryDelay(kind, bindingId, delayMs));
    this.gateRetryTimers.set(bindingId, handle);
  }

  private active(generation: number): boolean {
    return !this.suspended && generation === this.lifecycleGeneration;
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
   * Managed seat became idle — re-drive pending for that binding.
   * Phase 2 state machine (or ManagedTerminalDrive.onSeatIdle) should call this
   * so idle-gated prompts that returned false while busy can land.
   */
  onManagedTerminalIdle(bindingId: string): void {
    if (this.suspended) return;
    this.onSeatStateChanged(bindingId);
  }

  /** Pause released — re-drive everything held pending while paused. */
  onResumed(): void {
    if (this.suspended) return;
    // Operator action: release the bounded re-drive marks so every held
    // notice gets one fresh attempt (re-validated against the current doc).
    this.attemptedClaims.clear();
    this.transportAttempts.clear();
    this.wakeRetryCounts.clear();
    this.wakeRefusalLogged.clear();
    // Re-settle after pause so mail does not fire mid-resume paint.
    this.idleSinceByGeneration.clear();
    this.clearGateRetries();
    void this.retryRequestResponses();
    void this.sweepAllCanvases(() => true);
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
  private async retryRequestResponses(bindingId?: string): Promise<void> {
    const store = this.store;
    if (bindingId === undefined) {
      for (const [key, pending] of this.pendingRequestResponses) {
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
              `[request resolved - ${pending.requestId}] — vellum-command msg list`,
            )
          : sanitizeDeliveryLine(raw);
      const delivered = await this.deliver(
        transport,
        target,
        payload,
        `request:${pending.requestId}`,
        promptOptions,
      );
      if (delivered) this.pendingRequestResponses.delete(key);
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
    // is not a reconcile, and must not suppress the next one.
    let reconciled = true;
    for (const canvas of names) {
      if (!this.active(generation)) return;
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
    if (reconciled) this.lastReconcileAtMs = this.now();
    await this.retryPendingReadStamps(generation, match);
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
   * One seat's pending mail. Edge-map notices keep per-message attemptOne
   * (topology bounds); ordinary mail (including factory mail) batches into one
   * notify line on the same seat.
   */
  private async deliverGroup(
    generation: number,
    canvas: string,
    nodeId: string,
    messages: ReadonlyArray<Message>,
  ): Promise<void> {
    const edgeMap: Message[] = [];
    const ordinary: Message[] = [];
    for (const message of messages) {
      if (message.metadata?.edgeMapChange === true) edgeMap.push(message);
      else ordinary.push(message);
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
  }

  /**
   * Delivery already accepted, full-body read stamp still missing. Scan again
   * without listing the message as pending — never re-hit the PTY.
   */
  private async retryPendingReadStamps(
    generation: number,
    match: (target: SurfaceDeliveryTarget) => boolean,
  ): Promise<void> {
    const store = this.store;
    if (!store || this.pendingReadStamps.size === 0) return;
    for (const [key, pending] of [...this.pendingReadStamps]) {
      if (!this.active(generation)) return;
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
    let snap:
      | {
          readonly idle: boolean;
          readonly generationKey: string;
          readonly operatorDraft: boolean;
        }
      | undefined;
    try {
      snap = await transport.seatDeliverySnapshot(bindingId);
    } catch {
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS, "poll");
      return { allow: false, reason: "unavailable" };
    }
    if (!snap) {
      // Starting/restarting — short retry, not permanent strand.
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS, "poll");
      return { allow: false, reason: "unavailable" };
    }

    const prevKey = this.lastGenerationKey.get(bindingId);
    if (prevKey !== snap.generationKey) {
      if (prevKey !== undefined) this.idleSinceByGeneration.delete(prevKey);
      this.lastGenerationKey.set(bindingId, snap.generationKey);
      this.idleSinceByGeneration.delete(snap.generationKey);
      // New generation is a real state change — start polling fresh.
      this.gateRefusalStreak.delete(bindingId);
    }

    if (!snap.idle) {
      this.idleSinceByGeneration.delete(snap.generationKey);
      // Working seat will re-drive on idle transition; also timer as backstop.
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS, "poll");
      return { allow: false, reason: "not-idle" };
    }

    const nowMs = this.now();
    let idleSince = this.idleSinceByGeneration.get(snap.generationKey);
    if (idleSince === undefined) {
      idleSince = nowMs;
      this.idleSinceByGeneration.set(snap.generationKey, idleSince);
    }
    const elapsed = nowMs - idleSince;
    if (elapsed < MESSAGE_DELIVERY_SETTLE_MS) {
      this.scheduleGateRetry(
        bindingId,
        MESSAGE_DELIVERY_SETTLE_MS - elapsed + 10,
        "deadline",
      );
      return { allow: false, reason: "not-settled" };
    }

    if (snap.operatorDraft) {
      // Operator is typing — retry later; do not paste over their draft.
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS, "poll");
      return { allow: false, reason: "operator-draft" };
    }
    this.gateRefusalStreak.delete(bindingId);
    return { allow: true };
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
        this.forgetPending(canvas, nodeId, message.messageId);
        return;
      }
      if (isPendingDelivery(live) === false) {
        this.attemptedClaims.delete(key);
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
        // Settled idle + operator-keystroke draft gate.
        // Gate failure is not a transport failure — do not burn attempts or
        // edge-map claims (claim is recorded only after the gate allows).
        const gate = await this.evaluateSeatGate(target.bindingId);
        if (!gate.allow) return;

        // Edge-map notice law (bounded re-drive + stale re-validation):
        // AFTER the gate so a not-settled first consult cannot burn the claim.
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
          }
        }

        const payload = composeMessageDeliveryPayload(live);
        const promptOptions =
          transport.wakeManagedSeat || isFactoryMailMessage(live)
            ? {
                ...(transport.wakeManagedSeat ? { ready: true } : {}),
                // Only explicit factory mail steers a live turn. System
                // mailbox notices remain ordinary queued prompts.
                ...(isFactoryMailMessage(live)
                  ? { interruptIfBusy: true }
                  : {}),
              }
            : undefined;
        this.transportAttempts.set(key, (this.transportAttempts.get(key) ?? 0) + 1);
        const delivered = await this.deliver(
          transport,
          target,
          payload,
          live.messageId,
          promptOptions,
        );
        if (!delivered) return;
        this.transportAccepted.add(key);
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
   * inFlight / transportAccepted / attempt caps use a per-seat batch key
   * (not content-addressed message sets) so overlapping scans cannot double-paste.
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
      if (pending.length === 1) {
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
      if (livePending.length === 0) return;
      if (livePending.length === 1) {
        await this.attemptOne(canvas, nodeId, livePending[0]!);
        return;
      }

      const woke = await this.wakeManagedSeat(transport, canvas, nodeId);
      if (!woke) {
        // Arm wake retry on the first message so the batch has a future trigger.
        const first = livePending[0]!;
        const key = flightKey(canvas, nodeId, first.messageId);
        if (!this.wakeRefusalLogged.has(key)) {
          this.wakeRefusalLogged.add(key);
          console.error(
            `[delivery] wake refused — batch of ${String(livePending.length)} for ${canvas}/${nodeId} stays pending`,
          );
        }
        this.scheduleWakeRetry(generation, canvas, nodeId, first, key);
        return;
      }

      // Stamp-only path: transport already accepted this seat's batch once.
      if (this.transportAccepted.has(batchKey)) {
        for (const message of livePending) {
          const key = flightKey(canvas, nodeId, message.messageId);
          const accepted = await store.acceptMessageDelivery(
            canvas,
            nodeId,
            message.messageId,
          );
          if (accepted) {
            this.transportAccepted.delete(key);
            this.transportAttempts.delete(key);
            this.forgetPending(canvas, nodeId, message.messageId);
          }
        }
        let anyOpen = false;
        for (const message of livePending) {
          if (
            !(await store.hasAcceptedMessageDelivery(
              canvas,
              nodeId,
              message.messageId,
            ))
          ) {
            anyOpen = true;
            break;
          }
        }
        if (!anyOpen) {
          this.transportAccepted.delete(batchKey);
          this.transportAttempts.delete(batchKey);
        }
        return;
      }

      const attempts = this.transportAttempts.get(batchKey) ?? 0;
      if (attempts >= MessageDeliveryService.MAX_TRANSPORT_ATTEMPTS) {
        return;
      }

      const gate = await this.evaluateSeatGate(target.bindingId);
      if (!gate.allow) return;

      const payload = composeMessageDeliverySummary(
        sortMessagesNewestFirst(livePending),
      );
      const anyFactory = livePending.some((m) => isFactoryMailMessage(m));
      const promptOptions =
        transport.wakeManagedSeat || anyFactory
          ? {
              ...(transport.wakeManagedSeat ? { ready: true } : {}),
              ...(anyFactory ? { interruptIfBusy: true } : {}),
            }
          : undefined;

      this.transportAttempts.set(batchKey, attempts + 1);
      const delivered = await this.deliver(
        transport,
        target,
        payload,
        batchKey,
        promptOptions,
      );
      if (!delivered) return;
      this.transportAccepted.add(batchKey);

      for (const message of livePending) {
        const key = flightKey(canvas, nodeId, message.messageId);
        this.transportAccepted.add(key);
        const accepted = await store.acceptMessageDelivery(
          canvas,
          nodeId,
          message.messageId,
        );
        if (accepted) {
          this.transportAccepted.delete(key);
          this.transportAttempts.delete(key);
          this.wakeRetryCounts.delete(key);
          this.wakeRefusalLogged.delete(key);
          this.forgetPending(canvas, nodeId, message.messageId);
        } else {
          console.error(
            `[delivery] receipt stamp FAILED for ${canvas}/${nodeId}/${message.messageId} ` +
              `(batch transport accepted; re-paste suppressed by transportAccepted)`,
          );
        }
      }
      // Clear batch accept only when every message has a durable receipt.
      let anyOpen = false;
      for (const message of livePending) {
        if (
          !(await store.hasAcceptedMessageDelivery(
            canvas,
            nodeId,
            message.messageId,
          ))
        ) {
          anyOpen = true;
          break;
        }
      }
      if (!anyOpen) {
        this.transportAccepted.delete(batchKey);
        this.transportAttempts.delete(batchKey);
      }
    } catch {
      // Leave pending for idle/attach retry.
    } finally {
      this.inFlight.delete(batchKey);
    }
  }

  private async deliver(
    transport: MessageDeliveryTransport,
    target: SurfaceDeliveryTarget,
    payload: string,
    messageId: string,
    options?: ManagedTerminalPromptOptions,
  ): Promise<boolean> {
    // Managed drive (paste+CR) preferred; raw paste only for geography shells.
    if (transport.sendManagedTerminalPrompt) {
      return transport.sendManagedTerminalPrompt(target.bindingId, payload, options);
    }
    return transport.sendTerminalPaste?.(target.bindingId, payload, messageId) ?? false;
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
