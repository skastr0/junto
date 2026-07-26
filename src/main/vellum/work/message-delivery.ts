// Message delivery — one-way nudge from ether.messages onto live transports.
// Agent → ACP chatPrompt (must already be live; never openChat).
// Herdr → stock terminal.input text on an attached control stream.
// No delivery daemon, no retry queue, no polling: attempt on append + on attach.

import type { CanvasDoc, Message } from "@shared/canvas";
import {
  composeMessageDeliveryPayload,
  deliveryTargetOf,
  isPendingDelivery,
  listPendingDeliveries,
  stampMessageDelivered,
  type DeliveryTarget,
} from "@shared/message-delivery";

export type MessageDeliveryTransport = {
  readonly isAgentLive: (agentKey: string) => boolean;
  /** Returns true only when the prompt was accepted by a live session. */
  readonly sendAgentPrompt: (agentKey: string, text: string) => Promise<boolean>;
  /**
   * Write one line of plain text to a live herdr control stream for terminalId.
   * Returns false when no stream is attached.
   */
  readonly sendHerdrText: (terminalId: string, text: string) => boolean;
  /** Paste without submitting. A future harness-aware transport may consume messageId. */
  readonly sendTerminalPaste?: (bindingId: string, text: string, messageId: string) => boolean;
  /**
   * Managed-terminal drive: paste+CR into an agent seat PTY, idle-gated.
   * Prefer this over sendTerminalPaste for harness-bound native terminals.
   * Returns true only when the prompt was accepted (on the wire or queued-then-written).
   */
  readonly sendManagedTerminalPrompt?: (bindingId: string, text: string) => Promise<boolean>;
};

export type MessageDeliveryStore = {
  readonly listCanvasNames: () => Promise<ReadonlyArray<string>>;
  readonly readDoc: (canvas: string) => Promise<CanvasDoc | undefined>;
  /**
   * Serialized write path: apply stampMessageDelivered under the canvas mutex /
   * revision retry. Returns true when the stamp landed.
   */
  readonly stampDelivered: (
    canvas: string,
    nodeId: string,
    messageId: string,
    deliveredAt: number,
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
  private transport: MessageDeliveryTransport | undefined;
  private store: MessageDeliveryStore | undefined;
  private now: MessageDeliveryClock = () => Date.now();

  private seatPausedLookup: ((canvas: string, doc: CanvasDoc, nodeId: string) => boolean) | undefined;

  configure(input: {
    readonly transport: MessageDeliveryTransport;
    readonly store: MessageDeliveryStore;
    readonly now?: MessageDeliveryClock;
    /** Pause plane: a paused target keeps its messages pending (delivered on resume). */
    readonly seatPaused?: (canvas: string, doc: CanvasDoc, nodeId: string) => boolean;
  }): void {
    this.transport = input.transport;
    this.store = input.store;
    if (input.now) this.now = input.now;
    this.seatPausedLookup = input.seatPaused;
  }

  /** Test seam — drop all in-flight marks and deps. */
  resetForTest(): void {
    this.inFlight.clear();
    this.transportAccepted.clear();
    this.transport = undefined;
    this.store = undefined;
    this.now = () => Date.now();
  }

  /**
   * Called after a message lands on an agent/herdr node (WorkService append).
   * task-history appends never reach here (caller filters taskId !== null).
   */
  notifyAppended(canvas: string, nodeId: string, message: Message): void {
    if (!isPendingDelivery(message)) return;
    void this.attemptOne(canvas, nodeId, message);
  }

  /** Chat session just became live — deliver pending for that agent key. */
  onAgentLive(agentKey: string): void {
    void this.scanAndDeliver((target) => target.kind === "agent" && target.agentKey === agentKey);
  }

  /** Herdr control stream attached — deliver pending for that terminal. */
  onHerdrAttached(terminalId: string): void {
    void this.scanAndDeliver(
      (target) => target.kind === "herdr" && target.terminalId === terminalId,
    );
  }

  /** Native terminal session attached — offer pending messages as unsubmitted paste. */
  onTerminalAttached(bindingId: string): void {
    void this.scanAndDeliver(
      (target) => target.kind === "terminal" && target.bindingId === bindingId,
    );
  }

  /**
   * Managed seat became idle — re-drive pending for that binding.
   * Phase 2 state machine (or ManagedTerminalDrive.onSeatIdle) should call this
   * so idle-gated prompts that returned false while busy can land.
   */
  onManagedTerminalIdle(bindingId: string): void {
    void this.scanAndDeliver(
      (target) => target.kind === "terminal" && target.bindingId === bindingId,
    );
  }

  /** Pause released — re-drive everything held pending while paused. */
  onResumed(): void {
    void this.scanAndDeliver(() => true);
  }

  private async scanAndDeliver(
    match: (target: DeliveryTarget) => boolean,
  ): Promise<void> {
    const store = this.store;
    if (!store) return;
    let names: ReadonlyArray<string>;
    try {
      names = await store.listCanvasNames();
    } catch {
      return;
    }
    for (const canvas of names) {
      let doc: CanvasDoc | undefined;
      try {
        doc = await store.readDoc(canvas);
      } catch {
        continue;
      }
      if (!doc) continue;
      for (const pending of listPendingDeliveries(doc)) {
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
    if (!isPendingDelivery(message)) return;
    const transport = this.transport;
    const store = this.store;
    if (!transport || !store) return;

    const key = flightKey(canvas, nodeId, message.messageId);
    if (this.inFlight.has(key)) return; // at-most-once under burst
    this.inFlight.add(key);

    try {
      // Re-read before send: another worker may have stamped already.
      const doc = await store.readDoc(canvas);
      if (!doc) return;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      // Paused target: leave the message pending; resume re-drives it.
      if (this.seatPausedLookup?.(canvas, doc, nodeId)) return;
      const live = node.ether?.messages?.items.find((m) => m.messageId === message.messageId);
      if (!live) return;
      if (isPendingDelivery(live) === false) {
        // Already stamped on disk — drop transportAccepted residue.
        this.transportAccepted.delete(key);
        return;
      }

      const target = deliveryTargetOf(node);
      if (!target) return;

      // At-most-once: never re-hit the transport after a prior accept.
      if (!this.transportAccepted.has(key)) {
        const payload = composeMessageDeliveryPayload(live);
        const delivered = await this.deliver(transport, target, payload, live.messageId);
        if (!delivered) return;
        this.transportAccepted.add(key);
      }

      const at = this.now();
      const stamped = await store.stampDelivered(canvas, nodeId, live.messageId, at);
      if (stamped) this.transportAccepted.delete(key);
      // Stamp fail: keep transportAccepted so attach/idle only re-stamps.
    } catch {
      // Best-effort: leave pending; inFlight cleared so idle/attach can retry.
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async deliver(
    transport: MessageDeliveryTransport,
    target: DeliveryTarget,
    payload: string,
    messageId: string,
  ): Promise<boolean> {
    if (target.kind === "agent") {
      if (!transport.isAgentLive(target.agentKey)) return false;
      return transport.sendAgentPrompt(target.agentKey, payload);
    }
    if (target.kind === "terminal") {
      // Prefer managed drive (paste+CR, idle-gated) when wired; else unsubmitted paste.
      if (transport.sendManagedTerminalPrompt) {
        return transport.sendManagedTerminalPrompt(target.bindingId, payload);
      }
      return transport.sendTerminalPaste?.(target.bindingId, payload, messageId) ?? false;
    }
    // Terminal input is never implicitly submitted. Bracketed paste lets an
    // interactive harness distinguish the payload while shell metacharacters
    // remain inert until a human explicitly accepts/submits it.
    return transport.sendHerdrText(target.terminalId, `\u001b[200~${payload}\u001b[201~`);
  }
}

/** Process-wide singleton — configured once at app boot; tests call resetForTest. */
export const messageDelivery = new MessageDeliveryService();

/** Pure re-export for stamp path used by WorkService wiring. */
export { stampMessageDelivered };
