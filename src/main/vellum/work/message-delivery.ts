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
  deliveryTargetOf,
  isPendingDelivery,
  listPendingDeliveries,
  sanitizeDeliveryLine,
} from "@shared/message-delivery";
import type { SurfaceDeliveryTarget } from "@shared/actor-surface";

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
   * Record delivery.accepted after the PTY transport accepted the inject.
   * Returns true when the receipt is durable (or already existed).
   */
  readonly acceptMessageDelivery: (
    canvas: string,
    nodeId: string,
    messageId: string,
  ) => Promise<boolean>;
};

export type MessageDeliveryClock = () => number;

const flightKey = (canvas: string, nodeId: string, messageId: string): string =>
  `${canvas}::${nodeId}::${messageId}`;

export class MessageDeliveryService {
  private readonly inFlight = new Set<string>();
  /**
   * Process-local: transport accepted the nudge but document stamp may lag.
   * Later attach/idle re-drives must stamp only — never re-send (at-most-once).
   */
  private readonly transportAccepted = new Set<string>();
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
  }): void {
    if (this.suspended) return;
    this.transport = input.transport;
    this.store = input.store;
    if (input.now) this.now = input.now;
    this.seatPausedLookup = input.seatPaused;
  }

  /** Test seam — drop all in-flight marks and deps. */
  resetForTest(): void {
    this.lifecycleGeneration += 1;
    this.inFlight.clear();
    this.transportAccepted.clear();
    this.pendingRequestResponses.clear();
    this.transport = undefined;
    this.store = undefined;
    this.now = () => Date.now();
    this.seatPausedLookup = undefined;
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
    this.pendingRequestResponses.clear();
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
      const promptOptions = transport.wakeManagedSeat
        ? { ready: true }
        : undefined;
      const payload = sanitizeDeliveryLine(
        `[request resolved · ${pending.requestId}] ${pending.response}`,
      );
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
      for (const pending of listPendingDeliveries(doc)) {
        if (!this.active(generation)) return;
        if (!match(pending.target)) continue;
        await this.attemptOne(canvas, pending.nodeId, pending.message);
      }
    }
  }

  private async attemptOne(
    canvas: string,
    nodeId: string,
    message: Message,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active(generation)) return;
    if (!isPendingDelivery(message)) return;
    const transport = this.transport;
    const store = this.store;
    if (!transport || !store) return;

    const key = flightKey(canvas, nodeId, message.messageId);
    if (this.inFlight.has(key)) return; // at-most-once under burst
    this.inFlight.add(key);

    try {
      // Durable receipt is the stop condition (not canvas metadata.deliveredAt).
      if (await store.hasAcceptedMessageDelivery(canvas, nodeId, message.messageId)) {
        this.transportAccepted.delete(key);
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
      if (!live) return;
      if (isPendingDelivery(live) === false) {
        // Projected metadata already shows delivered — still ensure durable receipt.
        if (!this.transportAccepted.has(key)) {
          const accepted = await store.acceptMessageDelivery(canvas, nodeId, live.messageId);
          if (accepted) this.transportAccepted.delete(key);
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
      if (!woke) return;

      // At-most-once: never re-hit the transport after a prior accept.
      if (!this.transportAccepted.has(key)) {
        if (!this.active(generation)) return;
        const payload = composeMessageDeliveryPayload(live);
        const promptOptions =
          transport.wakeManagedSeat || live.metadata?.factoryMail === true
            ? {
                ...(transport.wakeManagedSeat ? { ready: true } : {}),
                // Only explicit factory mail steers a live turn. System
                // mailbox notices remain ordinary queued prompts.
                ...(live.metadata?.factoryMail === true
                  ? { interruptIfBusy: true }
                  : {}),
              }
            : undefined;
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

      const accepted = await store.acceptMessageDelivery(canvas, nodeId, live.messageId);
      if (accepted) this.transportAccepted.delete(key);
      // Accept fail: keep transportAccepted so attach/idle only re-receipts.
    } catch {
      // Best-effort: leave pending; inFlight cleared so idle/attach can retry.
    } finally {
      this.inFlight.delete(key);
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
}

/** Process-wide singleton — configured once at app boot; tests call resetForTest. */
export const messageDelivery = new MessageDeliveryService();
