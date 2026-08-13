// Message delivery — one-way nudge from ether.messages onto live transports.
// Actor targets come from kind-discriminated surfaces (managed terminal seats
// and raw geography shells). Geography holds no inbox, so a herdr pane is not
// a delivery target. No delivery daemon, no retry queue, no polling.
//
// Durable stop condition is work_delivery_receipts (delivery.accepted), not a
// canvas metadata stamp — work overlays are stripped on authorial write.

import type { CanvasDoc, Message } from "@shared/canvas";
import {
  composeMessageDeliveryPayload,
  composeMessageDeliverySummary,
  deliveryTargetOf,
  isFactoryMailMessage,
  isPendingDelivery,
  listPendingDeliveries,
  ptyInjectMarksRead,
  MESSAGE_PTY_FULL_BODY_MAX,
  sanitizeDeliveryLine,
} from "@shared/message-delivery";
import type { SurfaceDeliveryTarget } from "@shared/actor-surface";

/**
 * Quiet time after a generation first becomes idle before mail may paste.
 * Prevents open-to-continue from racing the load/resume paint with a dump.
 */
export const MESSAGE_DELIVERY_SETTLE_MS = 1_500;

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

export type MessageDeliveryStore = {
  readonly listCanvasNames: () => Promise<ReadonlyArray<string>>;
  readonly readDoc: (canvas: string) => Promise<CanvasDoc | undefined>;
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
  private timers: MessageDeliveryTimers = defaultTimers;
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
  }): void {
    if (this.suspended) return;
    this.transport = input.transport;
    this.store = input.store;
    if (input.now) this.now = input.now;
    this.seatPausedLookup = input.seatPaused;
    if (input.timers) this.timers = input.timers;
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
    this.transport = undefined;
    this.store = undefined;
    this.now = () => Date.now();
    this.seatPausedLookup = undefined;
    this.timers = defaultTimers;
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
  }

  /**
   * Re-drive one binding after a gate refusal without waiting for a seat-state
   * transition (already-idle seats never re-fire onManagedTerminalIdle).
   */
  private scheduleGateRetry(bindingId: string, delayMs: number): void {
    if (this.gateRetryTimers.has(bindingId)) return;
    const generation = this.lifecycleGeneration;
    const handle = this.timers.set(() => {
      this.gateRetryTimers.delete(bindingId);
      if (!this.active(generation)) return;
      void this.scanAndDeliver((target) => target.bindingId === bindingId);
      // Request-response shares the seat gate; re-drive those too.
      void this.retryRequestResponses(bindingId);
    }, Math.max(10, delayMs));
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

  /** Native terminal session attached — offer pending messages as unsubmitted paste. */
  onTerminalAttached(bindingId: string): void {
    if (this.suspended) return;
    void this.retryRequestResponses(bindingId);
    void this.scanAndDeliver(
      (target) => target.bindingId === bindingId,
    );
  }

  /**
   * Managed seat became idle — re-drive pending for that binding.
   * Phase 2 state machine (or ManagedTerminalDrive.onSeatIdle) should call this
   * so idle-gated prompts that returned false while busy can land.
   */
  onManagedTerminalIdle(bindingId: string): void {
    if (this.suspended) return;
    void this.retryRequestResponses(bindingId);
    void this.scanAndDeliver(
      (target) => target.bindingId === bindingId,
    );
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
    void this.scanAndDeliver(() => true);
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
    void this.scanAndDeliver(() => true);
  }

  private async retryRequestResponses(bindingId?: string): Promise<void> {
    for (const [key, pending] of this.pendingRequestResponses) {
      if (bindingId !== undefined) {
        const doc = await this.store?.readDoc(pending.canvas);
        const node = doc?.nodes.find((candidate) => candidate.id === pending.actorNodeId);
        if (node === undefined || deliveryTargetOf(node)?.bindingId !== bindingId) continue;
      }
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
      const doc = await store.readDoc(pending.canvas);
      if (!this.active(generation) || !doc) return;
      if (this.seatPausedLookup?.(pending.canvas, doc, pending.actorNodeId)) return;
      const node = doc.nodes.find((candidate) => candidate.id === pending.actorNodeId);
      if (!node) return;
      const target = deliveryTargetOf(node);
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

  private async scanAndDeliver(
    match: (target: SurfaceDeliveryTarget) => boolean,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active(generation)) return;
    const store = this.store;
    if (!store) return;
    let names: ReadonlyArray<string>;
    try {
      names = await store.listCanvasNames();
    } catch {
      await this.retryPendingReadStamps(generation, match);
      return;
    }
    if (!this.active(generation)) return;
    for (const canvas of names) {
      if (!this.active(generation)) return;
      let doc: CanvasDoc | undefined;
      try {
        doc = await store.readDoc(canvas);
      } catch {
        continue;
      }
      if (!this.active(generation)) return;
      if (!doc) continue;
      // Group pending by seat so wake can batch into one notify line.
      const groups = new Map<
        string,
        {
          readonly nodeId: string;
          readonly target: SurfaceDeliveryTarget;
          readonly messages: Message[];
        }
      >();
      for (const pending of listPendingDeliveries(doc)) {
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
      for (const group of groups.values()) {
        if (!this.active(generation)) return;
        // Edge-map notices keep per-message attemptOne (topology bounds).
        // Ordinary mail (including factory mail) batches on the same seat.
        const edgeMap: Message[] = [];
        const ordinary: Message[] = [];
        for (const message of group.messages) {
          if (message.metadata?.edgeMapChange === true) edgeMap.push(message);
          else ordinary.push(message);
        }
        if (ordinary.length === 1) {
          await this.attemptOne(canvas, group.nodeId, ordinary[0]!);
        } else if (ordinary.length > 1) {
          await this.attemptBatch(canvas, group.nodeId, ordinary);
        }
        for (const message of edgeMap) {
          if (!this.active(generation)) return;
          await this.attemptOne(canvas, group.nodeId, message);
        }
      }
    }
    await this.retryPendingReadStamps(generation, match);
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
      let doc: CanvasDoc | undefined;
      try {
        doc = await store.readDoc(pending.canvas);
      } catch {
        continue;
      }
      if (!this.active(generation)) return;
      if (!doc) continue;
      const node = doc.nodes.find((n) => n.id === pending.nodeId);
      if (!node) {
        this.pendingReadStamps.delete(key);
        continue;
      }
      const target = deliveryTargetOf(node);
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
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS);
      return { allow: false, reason: "unavailable" };
    }
    if (!snap) {
      // Starting/restarting — short retry, not permanent strand.
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS);
      return { allow: false, reason: "unavailable" };
    }

    const prevKey = this.lastGenerationKey.get(bindingId);
    if (prevKey !== snap.generationKey) {
      if (prevKey !== undefined) this.idleSinceByGeneration.delete(prevKey);
      this.lastGenerationKey.set(bindingId, snap.generationKey);
      this.idleSinceByGeneration.delete(snap.generationKey);
    }

    if (!snap.idle) {
      this.idleSinceByGeneration.delete(snap.generationKey);
      // Working seat will re-drive on idle transition; also timer as backstop.
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS);
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
      );
      return { allow: false, reason: "not-settled" };
    }

    if (snap.operatorDraft) {
      // Operator is typing — retry later; do not paste over their draft.
      this.scheduleGateRetry(bindingId, MESSAGE_DELIVERY_SETTLE_MS);
      return { allow: false, reason: "operator-draft" };
    }
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
          const doc = await store.readDoc(canvas);
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
        return;
      }
      if (!this.active(generation)) return;

      // Re-read before send: message may have been removed.
      const doc = await store.readDoc(canvas);
      if (!this.active(generation)) return;
      if (!doc) return;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      // Paused target: leave the message pending; resume re-drives it.
      if (this.seatPausedLookup?.(canvas, doc, nodeId)) return;
      const live = node.ether?.messages?.items.find((m) => m.messageId === message.messageId);
      if (!live) {
        // Message gone — drop the bounded re-drive mark so a re-appended
        // message with this id starts fresh (at-most-once is moot).
        this.attemptedClaims.delete(key);
        return;
      }
      if (isPendingDelivery(live) === false) {
        this.attemptedClaims.delete(key);
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
        if (!isPendingDelivery(message)) continue;
        if (await store.hasAcceptedMessageDelivery(canvas, nodeId, message.messageId)) {
          continue;
        }
        pending.push(message);
      }
      if (!this.active(generation) || pending.length === 0) return;
      if (pending.length === 1) {
        await this.attemptOne(canvas, nodeId, pending[0]!);
        return;
      }

      const doc = await store.readDoc(canvas);
      if (!this.active(generation) || !doc) return;
      if (this.seatPausedLookup?.(canvas, doc, nodeId)) return;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const target = deliveryTargetOf(node);
      if (!target) return;

      // Re-check each message still lives on the node as pending.
      const liveItems = node.ether?.messages?.items ?? [];
      const livePending = pending.filter((m) => {
        const live = liveItems.find((item) => item.messageId === m.messageId);
        return live !== undefined && isPendingDelivery(live);
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

      const payload = composeMessageDeliverySummary(livePending);
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
