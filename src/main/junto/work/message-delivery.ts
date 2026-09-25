/**
 * Mail delivery: every pending message on an agent seat's mailbox is typed
 * into that seat's input and submitted — at once, whatever the seat is doing.
 * The harness queues or steers what it receives; Junto adds no admission,
 * no refusal, no retry budget, and no hold.
 *
 * The sender chooses the shape. A notice writes one short "mail from X" line
 * that points at `junto msg read`; a prompt writes the full text.
 *
 * The only non-delivery is physical: the recipient seat does not exist, or
 * its terminal is not ready for input. That message waits in the mailbox and
 * is written the moment the seat is ready (`onSeatLive`), or at the boot
 * scan. Waiting mail starts its seat (`wakeSeat`): arriving work is the
 * reason to run the session, not an operator opening it. The wake keeps the
 * pause law, so a paused canvas or seat keeps its mail queued until play
 * (`onResumed`). A sender may opt one message out of the wake.
 *
 * Delivery is at-most-once per process: one flight per message, shared by
 * every caller that asks, and a delivered message is remembered until its
 * receipt reaches the document. The durable receipt (`deliveredAt`) is the
 * only delivery fact.
 */

import type { CanvasDoc, Message } from "@shared/canvas";
import { readMailExtension } from "@shared/crew";
import {
  composeImmediatePromptPayload,
  composeMessageDeliveryPayload,
  deliveryTargetOf,
  isPendingDelivery,
  listPendingDeliveries,
  MESSAGE_PTY_FULL_BODY_MAX,
  sanitizeDeliveryLine,
} from "@shared/message-delivery";

/** Whether a message reached its seat now, or waits for the seat to come up. */
export type MailDeliveryState = "delivered" | "waiting";

export type MessageDeliveryTransport = {
  /** The seat's terminal is up and ready to take a paste. */
  readonly seatLive: (bindingId: string) => boolean;
  /**
   * Start the seat's session headless so waiting mail can reach it. The
   * implementation owns every refusal (not local, paused, restart budget)
   * and resolves false for them. Absent = mail never starts a seat.
   */
  readonly wakeSeat?: (
    bindingId: string,
    canvas: string,
    nodeId: string,
  ) => Promise<boolean>;
  /**
   * Type the text into the seat's input and submit it. False only when the
   * seat had no live process to write into.
   */
  readonly writeMail: (bindingId: string, text: string) => Promise<boolean>;
};

/** Perf tag for each authority read: a boot scan, or one message's delivery. */
export type MessageDeliveryReadSite = "scan" | "attempt";

export type MessageDeliveryStore = {
  readonly listCanvasNames: () => Promise<ReadonlyArray<string>>;
  readonly readDoc: (
    canvas: string,
    site: MessageDeliveryReadSite,
  ) => Promise<CanvasDoc | undefined>;
  /** Stamp the durable delivery receipt (`deliveredAt`). */
  readonly acceptMessageDelivery: (
    canvas: string,
    nodeId: string,
    messageId: string,
  ) => Promise<boolean>;
};

type PendingMail = {
  readonly canvas: string;
  readonly nodeId: string;
  readonly messageId: string;
  /** Seat binding seen when the message was indexed; authority re-reads it. */
  readonly bindingId: string;
};

type PendingResponse = {
  readonly canvas: string;
  readonly actorNodeId: string;
  readonly requestId: string;
  readonly response: string;
};

const mailKey = (canvas: string, nodeId: string, messageId: string): string =>
  `${canvas}::${nodeId}::${messageId}`;

/** The text a message puts on the seat's input, by the sender's chosen kind. */
export const mailPayloadOf = (message: Message): string =>
  readMailExtension(message.metadata)?.mailKind === "prompt"
    ? composeImmediatePromptPayload(message)
    : composeMessageDeliveryPayload(message);

export class MessageDeliveryService {
  private transport: MessageDeliveryTransport | undefined;
  private store: MessageDeliveryStore | undefined;
  private suspended = false;
  private lifecycleGeneration = 0;
  /** Mail waiting for its seat, by message. */
  private readonly waiting = new Map<string, PendingMail>();
  /** One flight per message; a second caller shares the first one's result. */
  private readonly flights = new Map<string, Promise<MailDeliveryState>>();
  /** Delivered in this process; the receipt can lag the document it stamps. */
  private readonly delivered = new Set<string>();
  /** Writes into one seat land in order, one at a time. */
  private readonly seatChains = new Map<string, Promise<unknown>>();
  /** Operator answers to requests, waiting for the raising seat. */
  private readonly responses = new Map<string, PendingResponse>();
  /** Messages whose sender asked that they never start a seat. */
  private readonly noWake = new Set<string>();
  /** One wake in flight per seat. */
  private readonly waking = new Set<string>();

  configure(input: {
    readonly transport: MessageDeliveryTransport;
    readonly store: MessageDeliveryStore;
  }): void {
    this.transport = input.transport;
    this.store = input.store;
    this.suspended = false;
  }

  /** Stop every delivery this process owns; nothing writes after this. */
  suspend(): void {
    this.suspended = true;
    this.lifecycleGeneration += 1;
    this.transport = undefined;
    this.store = undefined;
    this.clear();
  }

  resetForTest(): void {
    this.lifecycleGeneration += 1;
    this.transport = undefined;
    this.store = undefined;
    this.suspended = false;
    this.clear();
  }

  private clear(): void {
    this.waiting.clear();
    this.flights.clear();
    this.delivered.clear();
    this.seatChains.clear();
    this.responses.clear();
    this.noWake.clear();
    this.waking.clear();
  }

  private active(generation: number): boolean {
    return !this.suspended && generation === this.lifecycleGeneration;
  }

  /**
   * Keep this message from starting its seat: it is written only if the
   * seat is already up, or when something else starts it. Call before the
   * append, so the append's own delivery sees it.
   */
  holdWake(messageId: string): void {
    if (!this.suspended) this.noWake.add(messageId);
  }

  /** A message landed on an actor mailbox: deliver it now. */
  notifyAppended(canvas: string, nodeId: string, message: Message): void {
    if (this.suspended || !isPendingDelivery(message)) return;
    void this.deliver(canvas, nodeId, message.messageId);
  }

  /**
   * Deliver one mailbox message now, or leave it waiting for its seat.
   * Callers that ask for the same message share one flight, so a caller
   * never races the append's own delivery.
   */
  deliver(
    canvas: string,
    nodeId: string,
    messageId: string,
  ): Promise<MailDeliveryState> {
    const key = mailKey(canvas, nodeId, messageId);
    if (this.delivered.has(key)) return Promise.resolve("delivered");
    const flying = this.flights.get(key);
    if (flying !== undefined) return flying;
    const flight = this.deliverOnce(canvas, nodeId, messageId, key)
      // An authority read failed: the message stays in the mailbox, where
      // a later seat-live event (once indexed) or the boot scan finds it.
      .catch((): MailDeliveryState => "waiting")
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    this.flights.set(key, flight);
    return flight;
  }

  private async deliverOnce(
    canvas: string,
    nodeId: string,
    messageId: string,
    key: string,
  ): Promise<MailDeliveryState> {
    const generation = this.lifecycleGeneration;
    const transport = this.transport;
    const store = this.store;
    if (!this.active(generation) || !transport || !store) return "waiting";
    const doc = await store.readDoc(canvas, "attempt");
    if (!this.active(generation)) return "waiting";
    const node = doc?.nodes.find((candidate) => candidate.id === nodeId);
    const message = node?.ether?.messages?.items.find(
      (item) => item.messageId === messageId,
    );
    const target = node === undefined ? undefined : deliveryTargetOf(node);
    if (!node || !message || !target) {
      // No seat to write into: the node is gone or holds no agent seat.
      this.waiting.delete(key);
      return "waiting";
    }
    if (!isPendingDelivery(message)) {
      this.waiting.delete(key);
      return "delivered";
    }
    this.waiting.set(key, { canvas, nodeId, messageId, bindingId: target.bindingId });
    if (!transport.seatLive(target.bindingId)) {
      if (!this.noWake.has(messageId)) {
        this.wake(transport, target.bindingId, canvas, nodeId, generation);
      }
      return "waiting";
    }
    const payload = mailPayloadOf(message);
    const written = await this.inSeatOrder(target.bindingId, () =>
      transport.writeMail(target.bindingId, payload),
    );
    if (!written || !this.active(generation)) return "waiting";
    this.delivered.add(key);
    this.waiting.delete(key);
    this.noWake.delete(messageId);
    await store.acceptMessageDelivery(canvas, nodeId, messageId).catch(() => {
      // The text is on the seat. A lost receipt only leaves the document
      // showing it waiting; this process will not type it twice.
      console.error(
        `[delivery] receipt stamp failed for ${canvas}/${nodeId}/${messageId}`,
      );
      return false;
    });
    return "delivered";
  }

  /**
   * Start the seat once for all the mail waiting on it. The seat's state
   * events then call `onSeatLive`, which writes the mail once it is ready.
   */
  private wake(
    transport: MessageDeliveryTransport,
    bindingId: string,
    canvas: string,
    nodeId: string,
    generation: number,
  ): void {
    if (transport.wakeSeat === undefined || this.waking.has(bindingId)) return;
    this.waking.add(bindingId);
    void transport
      .wakeSeat(bindingId, canvas, nodeId)
      .catch(() => false)
      .finally(() => {
        if (this.active(generation)) this.waking.delete(bindingId);
      });
  }

  /**
   * Play resumed on a canvas (or a seat or region in it): retry its waiting
   * mail, which starts the seats it is addressed to.
   */
  onResumed(canvas: string): void {
    if (this.suspended) return;
    const mail = [...this.waiting.values()]
      .filter((pending) => pending.canvas === canvas)
      .sort((a, b) => a.messageId.localeCompare(b.messageId));
    for (const pending of mail) {
      void this.deliver(pending.canvas, pending.nodeId, pending.messageId);
    }
  }

  /** Run one write after every earlier write into the same seat. */
  private inSeatOrder<T>(bindingId: string, write: () => Promise<T>): Promise<T> {
    const previous = this.seatChains.get(bindingId) ?? Promise.resolve();
    const next = previous.then(write, write);
    const tail = next.catch(() => undefined);
    this.seatChains.set(bindingId, tail);
    void tail.then(() => {
      if (this.seatChains.get(bindingId) === tail) this.seatChains.delete(bindingId);
    });
    return next;
  }

  /**
   * The seat's process came up (or its terminal changed state): write every
   * message and request answer that was waiting for it, oldest first.
   */
  onSeatLive(bindingId: string): void {
    if (this.suspended) return;
    const mail = [...this.waiting.values()]
      .filter((pending) => pending.bindingId === bindingId)
      .sort((a, b) => a.messageId.localeCompare(b.messageId));
    for (const pending of mail) {
      void this.deliver(pending.canvas, pending.nodeId, pending.messageId);
    }
    for (const [key, response] of this.responses) {
      void this.deliverResponse(key, response, bindingId);
    }
  }

  /**
   * Boot scan: mail appended while no process ran has no append event left.
   * Index every pending message, and write what already has a live seat.
   */
  async onBooted(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const store = this.store;
    if (!this.active(generation) || !store) return;
    let names: ReadonlyArray<string>;
    try {
      names = await store.listCanvasNames();
    } catch {
      return;
    }
    for (const canvas of names) {
      if (!this.active(generation)) return;
      const doc = await store.readDoc(canvas, "scan").catch(() => undefined);
      if (!doc) continue;
      const pending = [...listPendingDeliveries(doc)].sort((a, b) =>
        a.message.messageId.localeCompare(b.message.messageId),
      );
      for (const item of pending) {
        void this.deliver(canvas, item.nodeId, item.message.messageId);
      }
    }
  }

  /**
   * Push an operator's answer into the seat that raised the request, now or
   * when that seat comes up. Process-local: the resolved request stays the
   * durable record.
   */
  notifyRequestResolved(input: PendingResponse): void {
    if (this.suspended) return;
    const key = `${input.canvas}::${input.actorNodeId}::request::${input.requestId}`;
    this.responses.set(key, input);
    void this.deliverResponse(key, input);
  }

  private async deliverResponse(
    key: string,
    pending: PendingResponse,
    onlyBinding?: string,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    const transport = this.transport;
    const store = this.store;
    if (!this.active(generation) || !transport || !store) return;
    if (this.flights.has(key)) return;
    const flight = (async (): Promise<MailDeliveryState> => {
      const doc = await store.readDoc(pending.canvas, "attempt");
      const node = doc?.nodes.find((candidate) => candidate.id === pending.actorNodeId);
      const target = node === undefined ? undefined : deliveryTargetOf(node);
      if (!target) {
        this.responses.delete(key);
        return "waiting";
      }
      if (onlyBinding !== undefined && target.bindingId !== onlyBinding) return "waiting";
      if (!this.active(generation) || !transport.seatLive(target.bindingId)) {
        return "waiting";
      }
      const raw = `[request resolved - ${pending.requestId}] ${pending.response}`;
      const payload =
        sanitizeDeliveryLine(raw).length > MESSAGE_PTY_FULL_BODY_MAX
          ? sanitizeDeliveryLine(`[request resolved - ${pending.requestId}] — junto msg list`)
          : sanitizeDeliveryLine(raw);
      const written = await this.inSeatOrder(target.bindingId, () =>
        transport.writeMail(target.bindingId, payload),
      );
      if (!written) return "waiting";
      this.responses.delete(key);
      return "delivered";
    })().catch((): MailDeliveryState => "waiting");
    this.flights.set(key, flight);
    try {
      await flight;
    } finally {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    }
  }
}

export const messageDelivery = new MessageDeliveryService();
