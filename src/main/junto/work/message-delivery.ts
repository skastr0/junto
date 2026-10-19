/**
 * Mail delivery: every pending message on an agent seat's mailbox is typed
 * into that seat's input and submitted — at once, whatever the seat is doing.
 * Mail asks for steering. While a turn is running, the harness follow-up
 * contract says how many Enters that takes. Junto adds no admission,
 * no refusal, no retry budget, and no hold.
 *
 * The sender chooses the shape. A notice is typed whole, up to 2,500
 * characters, under one header that names the sender as the canvas does, the
 * mail's id and thread, and the `junto msg reply` that answers it; past that
 * it is cut, with a pointer to `junto msg read`. A prompt writes the full
 * text. Mail typed whole is marked read as it is typed. Either way the first
 * line also points at `junto onboard` while the recipient has not onboarded:
 * nothing is sent at session start, so mail is where a fresh seat learns the
 * command that loads it.
 *
 * The only non-delivery is physical: the recipient seat does not exist, or
 * its terminal is not ready for input. That message waits in the mailbox and
 * is written the moment the seat is ready (`onSeatLive`), or at the boot
 * scan. Waiting mail starts its seat (`wakeSeat`): arriving work is the
 * reason to run the session, not an operator opening it. The wake keeps the
 * pause law, so a paused canvas or seat keeps its mail queued until play
 * (`onResumed`). A sender may opt one message out of the wake.
 *
 * Mail is typed only into an available input box. While the operator is
 * composing there, a dialog is up, or the box cannot be read, typing would
 * submit their draft, answer the dialog, or land nowhere known. That mail
 * waits, in order, and is written once the box is available (`onSeatLive`,
 * plus a retry every minute). There is no time limit, so the wait is told
 * on the seat: once for a draft, every minute for a dialog or an unreadable
 * box, which only the operator can clear.
 *
 * A harness is never typed into turn after turn. Notices for one seat gather
 * into one turn (`MAIL_BATCHING`): typed after 2 s with no new mail, and at
 * most 10 s after the first. A batch keeps gathering until its write starts,
 * so mail that comes while an earlier turn is being typed, while the box is
 * held, or while the seat is down rides the next turn. A prompt is a turn its
 * sender asked for: typed alone, after the mail already gathering.
 *
 * Delivery is at-most-once per process: one flight per message, shared by
 * every caller that asks, and a delivered message is remembered until its
 * receipt reaches the mailbox. The durable receipt (`deliveredAt`) is the
 * only delivery fact.
 *
 * Mail is typed on the machine its seat runs on. A seat on another machine
 * is not written to, woken or retried here; its mail stays in the mailbox
 * for that machine.
 */

import { asNodeId, type Canvas, type Node } from "@shared/model";
import { isThisMachine } from "@shared/machine-identity";
import { thisMachineName } from "../term/machine-name";
import type { Message } from "@shared/work-model";
import { readMailExtension } from "@shared/crew";
import {
  composeImmediatePromptPayload,
  composeMailBatch,
  deliveryTargetOf,
  isPendingDelivery,
  MESSAGE_PTY_FULL_BODY_MAX,
  sanitizeDeliveryLine,
  type MailSender,
} from "@shared/message-delivery";
import { seatIdentity, seatLabel } from "@shared/model/seat-identity";
import type { MailHold } from "@shared/mail-hold";
import {
  wireTrafficOfMail,
  wireTrafficPreview,
  type WireTrafficEvent,
} from "@shared/wire-traffic";

/**
 * How often held mail is tried again and, for a dialog or an unreadable box,
 * told again on the seat.
 */
export const MAIL_HELD_RETRY_MS = 60_000;

/** How notices for one seat gather into one typed turn. */
export type MailBatching = {
  /** A batch is typed once no mail has joined it for this long. */
  readonly quietMs: number;
  /** And at most this long after its first mail, however steadily mail comes. */
  readonly maxWaitMs: number;
};

/**
 * 2 s of quiet: a burst of `junto msg send`, one CLI process each, lands
 * inside it, and a lone mail is late by less than a harness turn takes. 10 s
 * at most, so a steady trickle never holds mail longer than that.
 */
export const MAIL_BATCHING: MailBatching = { quietMs: 2_000, maxWaitMs: 10_000 };

/**
 * How many waiting mails a seat-live pass starts before it yields the event
 * loop. A seat with thousands waiting otherwise starts every read in one
 * tick, and the link's frames and a seat start's own answer wait behind them.
 */
export const MAIL_PASS_CHUNK = 64;

/** Whether a message reached its seat now, or waits for the seat to come up. */
/**
 * What became of mail, as its sender is told. `delivered` and `waiting` are
 * for a seat of this machine: typed into it, or kept until it can be. For a
 * seat of another machine the mail is `handed` to an open link on its way
 * there, or `held` here until a link opens.
 */
export type MailDeliveryState = "delivered" | "waiting" | "handed" | "held";

/** Is a link open that mail for this seat of another machine leaves on. */
export type MailLinkRoute = (canvas: string, nodeId: string) => Promise<boolean>;

export type MessageDeliveryTransport = {
  /** The seat's terminal is up and ready to take a paste. */
  readonly seatLive: (bindingId: string) => boolean;
  /**
   * `junto onboard` ran in the seat's current harness session. False puts the
   * onboard pointer on the mail line. Absent = no pointer.
   */
  readonly seatOnboarded?: (bindingId: string) => boolean;
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
   * Type the text into the seat's input and submit it. A hold reason when
   * the input box was not available and nothing was typed; "lost" when the
   * seat had no live process to write into.
   */
  readonly writeMail: (
    bindingId: string,
    text: string,
  ) => Promise<"written" | "lost" | MailHold>;
};

/** Perf tag for each authority read: a boot scan, or one message's delivery. */
export type MessageDeliveryReadSite = "scan" | "attempt";

export type MessageDeliveryStore = {
  readonly listCanvasNames: () => Promise<ReadonlyArray<string>>;
  readonly readModel: (
    canvas: string,
    site: MessageDeliveryReadSite,
  ) => Promise<Canvas | undefined>;
  readonly readMessage: (canvas: string, nodeId: string, messageId: string) => Promise<Message | undefined>;
  readonly listMail: (canvas: string, nodeId: string) => Promise<ReadonlyArray<Message>>;
  /**
   * Stamp the durable delivery receipt (`deliveredAt`), and with `read` the
   * read receipt (`readAt`) beside it: mail typed whole is read.
   */
  readonly acceptMessageDelivery: (
    canvas: string,
    nodeId: string,
    messageId: string,
    read: boolean,
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

/** One mail on its way into its seat; `settle` answers its flight. */
type Gathered = {
  readonly key: string;
  readonly canvas: string;
  readonly nodeId: string;
  readonly message: Message;
  readonly sender: MailSender | undefined;
  readonly settle: (state: MailDeliveryState) => void;
};

/** Notices gathering for one seat's next turn. */
type SeatBatch = {
  readonly bindingId: string;
  readonly generation: number;
  readonly firstAt: number;
  readonly mail: Gathered[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Its quiet is over: it waits only for the seat's earlier writes. */
  due: boolean;
};

/** One write into a seat, and the mail it carried, oldest first. */
type Typed = {
  readonly mail: ReadonlyArray<Gathered>;
  /** Whether each mail went in whole, so is read. */
  readonly whole: ReadonlyArray<boolean>;
  readonly written: "written" | "lost" | MailHold;
};

const oldestFirst = (a: Gathered, b: Gathered): number => a.message.messageId.localeCompare(b.message.messageId);

/**
 * The sender as the canvas names it now: its name and every region around
 * it, and its node for the reply. Undefined when it is not on this canvas;
 * the mail then names the sender as it was stamped.
 */
const senderOn = (doc: Canvas, message: Message): MailSender | undefined => {
  const nodeId = message.metadata?.senderNodeId;
  const node = typeof nodeId === "string" ? doc.nodes.get(asNodeId(nodeId)) : undefined;
  return node === undefined ? undefined : { label: seatLabel(seatIdentity(doc, node)), replyTarget: node.id };
};

/** A lookup that fails must never cost a delivery: no answer means no pointer. */
const onboardedOf = (
  transport: MessageDeliveryTransport,
  bindingId: string,
): boolean => {
  try {
    return transport.seatOnboarded?.(bindingId) ?? true;
  } catch {
    return true;
  }
};

export class MessageDeliveryService {
  /** This machine's name, read at each decision; how notices gather. */
  constructor(
    private readonly thisMachine: () => string = thisMachineName,
    private readonly batching: MailBatching = MAIL_BATCHING,
  ) {}

  /**
   * The seat mail is typed into here: an agent seat on this machine.
   * `elsewhere` is a seat another machine types into.
   */
  private targetHere(node: Node): ReturnType<typeof deliveryTargetOf> | "elsewhere" {
    // A peer is a seat of another machine, as a copy of a canvas holds it.
    if (node.kind === "peer") return "elsewhere";
    const target = deliveryTargetOf(node);
    if (target === undefined || node.kind !== "agent") return undefined;
    return isThisMachine(node.host, this.thisMachine()) ? target : "elsewhere";
  }

  private transport: MessageDeliveryTransport | undefined;
  private store: MessageDeliveryStore | undefined;
  private linkRoute: MailLinkRoute | undefined;

  /** The core's links: without them, mail for another machine is always held. */
  followLinks(route: MailLinkRoute | undefined): void {
    this.linkRoute = route;
  }
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
  /** Each seat's gathering batch, by binding; it leaves here as its write starts. */
  private readonly batches = new Map<string, SeatBatch>();
  /** Operator answers to requests, waiting for the raising seat. */
  private readonly responses = new Map<string, PendingResponse>();
  /** Messages whose sender asked that they never start a seat. */
  private readonly noWake = new Set<string>();
  /** One wake in flight per seat. */
  private readonly waking = new Set<string>();
  /** Seats with a seat-live pass walking their mail; true asks for one more pass after it. */
  private readonly passes = new Map<string, boolean>();
  /** Mail whose failed write was already told; cleared once it lands. */
  private readonly failedTold = new Set<string>();
  /** Held mail already told, with why and when; cleared once it lands. */
  private readonly heldTold = new Map<string, { reason: MailHold; at: number }>();
  /** One retry timer per held message; see MAIL_HELD_RETRY_MS. */
  private readonly heldRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Told once per message typed into a seat (wire pulse, preambles). */
  private readonly deliveredListeners = new Set<(event: WireTrafficEvent) => void>();

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
    for (const batch of this.batches.values()) {
      if (batch.timer !== undefined) clearTimeout(batch.timer);
      for (const mail of batch.mail) mail.settle("waiting");
    }
    this.batches.clear();
    this.waiting.clear();
    this.flights.clear();
    this.delivered.clear();
    this.seatChains.clear();
    this.responses.clear();
    this.noWake.clear();
    this.waking.clear();
    this.passes.clear();
    this.failedTold.clear();
    this.heldTold.clear();
    for (const timer of this.heldRetries.values()) clearTimeout(timer);
    this.heldRetries.clear();
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

  /**
   * Listen for every message actually typed into a seat. The one source of
   * wire traffic: the canvas pulse and the preamble surface both read it.
   */
  subscribeDelivered(listener: (event: WireTrafficEvent) => void): () => void {
    this.deliveredListeners.add(listener);
    return () => {
      this.deliveredListeners.delete(listener);
    };
  }

  private emitDelivered(event: WireTrafficEvent): void {
    for (const listener of this.deliveredListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[delivery] wire traffic listener failed:", error);
      }
    }
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
      .catch((error: unknown): MailDeliveryState => {
        console.error(`[delivery] attempt failed for ${canvas}/${nodeId}/${messageId}: ${String(error)}`);
        return "waiting";
      })
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
    const waiting = (reason: string): MailDeliveryState => {
      console.info(`[delivery] waiting for ${canvas}/${nodeId}/${messageId}: ${reason}`);
      return "waiting";
    };
    if (!this.active(generation)) return waiting("delivery generation ended");
    if (!transport || !store) return waiting("delivery not configured: store or transport missing");
    const doc = await store.readModel(canvas, "attempt");
    if (!this.active(generation)) return waiting("delivery generation ended during model read");
    if (!doc) return waiting("model unavailable");
    const node = doc?.nodes.get(asNodeId(nodeId));
    const message = await store.readMessage(canvas, nodeId, messageId);
    const target = node === undefined ? undefined : this.targetHere(node);
    if (target === "elsewhere") {
      this.waiting.delete(key);
      const handed = (await this.linkRoute?.(canvas, nodeId).catch(() => false)) ?? false;
      console.info(
        `[delivery] ${canvas}/${nodeId}/${messageId}: the seat runs on another machine, mail ${handed ? "handed to a link" : "held until a link opens"}`,
      );
      return handed ? "handed" : "held";
    }
    if (!node || !message || !target) {
      // No seat to write into: the node is gone or holds no agent seat.
      // Said in the log: the mail starts no seat from here, and a silent
      // return is a wake that never happens with no trace of why.
      const missing = !node ? "node is not on the canvas" : !target ? "node holds no agent seat" : "message is not in the mailbox";
      console.error(`[delivery] not attempted for ${canvas}/${nodeId}/${messageId}: ${missing}`);
      this.waiting.delete(key);
      return "waiting";
    }
    if (!isPendingDelivery(message)) {
      console.info(`[delivery] not pending for ${canvas}/${nodeId}/${messageId}: role=${message.role}, readAt=${String(message.metadata?.readAt)}, deliveredAt=${String(message.metadata?.deliveredAt)}`);
      this.waiting.delete(key);
      return "delivered";
    }
    this.waiting.set(key, { canvas, nodeId, messageId, bindingId: target.bindingId });
    if (!transport.seatLive(target.bindingId)) {
      if (this.noWake.has(messageId)) return waiting("no-wake message, seat is not ready");
      return waiting(`seat is not ready, ${this.wake(transport, target.bindingId, canvas, nodeId, generation, messageId)}`);
    }
    const sender = senderOn(doc, message);
    const mail = { key, canvas, nodeId, message, sender };
    if (readMailExtension(message.metadata)?.mailKind !== "prompt") {
      return this.gather(target.bindingId, mail, generation);
    }
    // A prompt is its own turn. The batch gathering now is typed first and
    // closed, so mail sent after the prompt is typed after it.
    const open = this.batches.get(target.bindingId);
    if (open !== undefined) {
      this.batches.delete(target.bindingId);
      void this.typeBatch(open);
    }
    const payload = composeImmediatePromptPayload(message, {
      onboarded: onboardedOf(transport, target.bindingId),
      ...(sender === undefined ? {} : { sender }),
    });
    let state: MailDeliveryState = "waiting";
    const written = await this.inSeatOrder(target.bindingId, () => transport.writeMail(target.bindingId, payload));
    await this.landed(
      { mail: [{ ...mail, settle: (answer) => { state = answer; } }], whole: [true], written },
      store,
      generation,
    );
    return state;
  }

  /**
   * Add a notice to its seat's batch. Each arrival restarts the quiet; the
   * first mail's maximum wait does not move. Answers once the batch is typed,
   * or once its mail goes back to waiting.
   */
  private gather(
    bindingId: string,
    mail: Omit<Gathered, "settle">,
    generation: number,
  ): Promise<MailDeliveryState> {
    return new Promise((settle) => {
      const open = this.batches.get(bindingId);
      const batch: SeatBatch = open ?? { bindingId, generation, firstAt: Date.now(), mail: [], timer: undefined, due: false };
      if (open === undefined) this.batches.set(bindingId, batch);
      batch.mail.push({ ...mail, settle });
      if (batch.due) return;
      if (batch.timer !== undefined) clearTimeout(batch.timer);
      const wait = Math.min(this.batching.quietMs, batch.firstAt + this.batching.maxWaitMs - Date.now());
      batch.timer = setTimeout(() => void this.typeBatch(batch), Math.max(0, wait));
      batch.timer.unref?.();
    });
  }

  /**
   * Type a seat's batch as one turn, after every earlier write into it. Until
   * that write starts the batch keeps gathering. Whatever happens, every mail
   * in it is answered.
   */
  private async typeBatch(batch: SeatBatch): Promise<void> {
    if (batch.due) return;
    batch.due = true;
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    batch.timer = undefined;
    const store = this.store;
    try {
      const typed = await this.inSeatOrder(batch.bindingId, () => this.writeBatch(batch));
      if (typed !== undefined && store !== undefined) await this.landed(typed, store, batch.generation);
    } catch (error) {
      console.error(`[delivery] batch for ${batch.bindingId} failed: ${String(error)}`);
    } finally {
      for (const mail of batch.mail) mail.settle("waiting");
    }
  }

  /**
   * The batch's write. It closes the batch: mail from here on gathers for
   * the next turn. Mail read while it gathered is not typed, and a seat that
   * went down leaves it all waiting for `onSeatLive`.
   */
  private async writeBatch(batch: SeatBatch): Promise<Typed | undefined> {
    if (this.batches.get(batch.bindingId) === batch) this.batches.delete(batch.bindingId);
    const transport = this.transport;
    const store = this.store;
    if (!this.active(batch.generation) || !transport || !store) return undefined;
    if (!transport.seatLive(batch.bindingId)) return undefined;
    const pending: Gathered[] = [];
    for (const mail of [...batch.mail].sort(oldestFirst)) {
      const now = await store.readMessage(mail.canvas, mail.nodeId, mail.message.messageId);
      if (now !== undefined && isPendingDelivery(now)) {
        pending.push(mail);
      } else {
        this.waiting.delete(mail.key);
        mail.settle("delivered");
      }
    }
    if (pending.length === 0 || !this.active(batch.generation)) return undefined;
    const { text, whole } = composeMailBatch(
      pending.map(({ message, sender }) => ({ message, ...(sender === undefined ? {} : { sender }) })),
      { onboarded: onboardedOf(transport, batch.bindingId) },
    );
    return { mail: pending, whole, written: await transport.writeMail(batch.bindingId, text) };
  }

  /** What one write did to each mail it carried, told and stamped. */
  private async landed(typed: Typed, store: MessageDeliveryStore, generation: number): Promise<void> {
    const { mail, whole, written } = typed;
    if (!this.active(generation)) return;
    // The seat's input box was not available. Nothing was typed and nothing
    // failed: the transport says when it is available again, and a retry
    // every minute does not depend on that signal.
    if (written !== "written" && written !== "lost") {
      for (const one of mail) {
        console.info(`[delivery] waiting for ${one.canvas}/${one.nodeId}/${one.message.messageId}: composer held: ${written}`);
        this.tellHeld(one.canvas, one.nodeId, one.message, one.key, written);
        this.retryHeld(one.canvas, one.nodeId, one.message.messageId, one.key, generation);
        one.settle("waiting");
      }
      return;
    }
    if (written !== "written") {
      // The seat was live but the text did not land (it restarted or
      // exited mid-write). The mail waits for the seat's next ready moment;
      // say so once, since a silent wait here is what the operator misses.
      for (const one of mail) {
        console.info(`[delivery] waiting for ${one.canvas}/${one.nodeId}/${one.message.messageId}: seat lost during mail write`);
        if (!this.failedTold.has(one.key)) {
          this.failedTold.add(one.key);
          this.emitDelivered({
            ...wireTrafficOfMail({ canvasName: one.canvas, toNodeId: one.nodeId, message: one.message, at: Date.now() }),
            failed: true,
          });
        }
        one.settle("waiting");
      }
      return;
    }
    for (const one of mail) {
      this.failedTold.delete(one.key);
      this.heldTold.delete(one.key);
      const retry = this.heldRetries.get(one.key);
      if (retry !== undefined) clearTimeout(retry);
      this.heldRetries.delete(one.key);
      this.delivered.add(one.key);
      this.waiting.delete(one.key);
      this.noWake.delete(one.message.messageId);
      this.emitDelivered(
        wireTrafficOfMail({ canvasName: one.canvas, toNodeId: one.nodeId, message: one.message, at: Date.now() }),
      );
    }
    for (const [index, one] of mail.entries()) {
      const { canvas, nodeId, message } = one;
      const accepted = await store.acceptMessageDelivery(canvas, nodeId, message.messageId, whole[index] === true).catch((cause: unknown) => {
        // The text is on the seat. A lost receipt only leaves the document
        // showing it waiting; this process will not type it twice.
        console.error(
          `[delivery] receipt stamp failed for ${canvas}/${nodeId}/${message.messageId}: ${String(cause)}`,
        );
        return undefined;
      });
      if (accepted === false) console.error(`[delivery] receipt refused for ${canvas}/${nodeId}/${message.messageId}`);
      one.settle("delivered");
    }
  }

  /**
   * Say on the seat that this mail is waiting and why. A draft is told once:
   * the operator is looking at it. A dialog or an unreadable box is told
   * again every minute, because that wait ends only when someone notices.
   */
  private tellHeld(
    canvas: string,
    nodeId: string,
    message: Message,
    key: string,
    reason: MailHold,
  ): void {
    const now = Date.now();
    const told = this.heldTold.get(key);
    if (
      told !== undefined &&
      told.reason === reason &&
      (reason === "draft" || now - told.at < MAIL_HELD_RETRY_MS)
    ) {
      return;
    }
    this.heldTold.set(key, { reason, at: now });
    this.emitDelivered({
      ...wireTrafficOfMail({ canvasName: canvas, toNodeId: nodeId, message, at: now }),
      held: reason,
    });
  }

  /** Try a held message again in a minute, whatever else happens. */
  private retryHeld(
    canvas: string,
    nodeId: string,
    messageId: string,
    key: string,
    generation: number,
  ): void {
    if (this.heldRetries.has(key)) return;
    const timer = setTimeout(() => {
      this.heldRetries.delete(key);
      if (this.active(generation)) void this.deliver(canvas, nodeId, messageId);
    }, MAIL_HELD_RETRY_MS);
    timer.unref?.();
    this.heldRetries.set(key, timer);
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
    messageId: string,
  ): string {
    if (transport.wakeSeat === undefined || this.waking.has(bindingId)) {
      return transport.wakeSeat === undefined ? "wake transport missing" : "wake already in flight";
    }
    this.waking.add(bindingId);
    void transport
      .wakeSeat(bindingId, canvas, nodeId)
      .catch((error: unknown) => {
        console.error(`[delivery] wake failed for ${canvas}/${nodeId}/${messageId} (${bindingId}): ${String(error)}`);
        return false;
      })
      .finally(() => {
        if (this.active(generation)) this.waking.delete(bindingId);
      });
    return "wake requested";
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
   * The seat's process came up, its terminal changed state, or the operator
   * finished drafting in it: write every message and request answer that was
   * waiting for it, oldest first. A seat that is not ready yet (it is
   * starting) gets one attempt, for its oldest mail, which asks for the wake
   * again; the rest stays indexed for the pass once it is ready.
   */
  onSeatLive(bindingId: string): void {
    if (this.suspended) return;
    const mail = [...this.waiting.values()]
      .filter((pending) => pending.bindingId === bindingId)
      .sort((a, b) => a.messageId.localeCompare(b.messageId));
    if (this.transport?.seatLive(bindingId) === true) this.walk(bindingId, mail);
    else if (mail[0] !== undefined) void this.deliver(mail[0].canvas, mail[0].nodeId, mail[0].messageId);
    for (const [key, response] of this.responses) {
      void this.deliverResponse(key, response, bindingId);
    }
  }

  /**
   * Start a seat's waiting mail in order, a chunk per event-loop turn; one
   * pass per seat at a time. A seat that stops being ready ends the pass: the
   * rest stays waiting for its next live event, and nothing asks for a wake
   * per mail.
   */
  private walk(bindingId: string, mail: ReadonlyArray<PendingMail>): void {
    if (this.passes.has(bindingId)) {
      this.passes.set(bindingId, true);
      return;
    }
    this.passes.set(bindingId, false);
    const generation = this.lifecycleGeneration;
    const step = (from: number): void => {
      if (!this.active(generation)) return;
      if (from > 0 && this.transport?.seatLive(bindingId) !== true) {
        this.passes.delete(bindingId);
        return;
      }
      for (const pending of mail.slice(from, from + MAIL_PASS_CHUNK)) {
        void this.deliver(pending.canvas, pending.nodeId, pending.messageId);
      }
      if (from + MAIL_PASS_CHUNK < mail.length) {
        setImmediate(() => step(from + MAIL_PASS_CHUNK));
        return;
      }
      const again = this.passes.get(bindingId) === true;
      this.passes.delete(bindingId);
      if (again) this.onSeatLive(bindingId);
    };
    step(0);
  }

  /**
   * Boot scan: mail appended while no process ran has no append event left.
   * Index every pending message, and write what already has a live seat.
   */
  async onBooted(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const store = this.store;
    if (!this.active(generation) || !store) return;
    try {
      this.thisMachine();
    } catch (error) {
      // Which seats are this machine's is not known yet: nothing can be indexed.
      console.error(`[delivery] boot scan skipped: ${String(error)}`);
      return;
    }
    let names: ReadonlyArray<string>;
    try {
      names = await store.listCanvasNames();
    } catch {
      return;
    }
    for (const canvas of names) {
      if (!this.active(generation)) return;
      const doc = await store.readModel(canvas, "scan").catch(() => undefined);
      if (!doc) continue;
      const pending: Array<{ nodeId: string; message: Message }> = [];
      for (const node of doc.nodes.values()) {
        const target = this.targetHere(node);
        if (target === undefined || target === "elsewhere") continue;
        for (const message of await store.listMail(canvas, node.id)) {
          if (isPendingDelivery(message)) pending.push({ nodeId: node.id, message });
        }
      }
      pending.sort((a, b) => a.message.messageId.localeCompare(b.message.messageId));
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
      const doc = await store.readModel(pending.canvas, "attempt");
      const node = doc?.nodes.get(asNodeId(pending.actorNodeId));
      const target = node === undefined ? undefined : this.targetHere(node);
      if (target === undefined || target === "elsewhere") {
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
      if (written !== "written") return "waiting";
      this.responses.delete(key);
      const preview = wireTrafficPreview(pending.response);
      this.emitDelivered({
        canvasName: pending.canvas,
        toNodeId: pending.actorNodeId,
        fromName: "operator",
        kind: "answer",
        messageId: `request::${pending.requestId}`,
        ...(preview !== undefined ? { preview } : {}),
        at: Date.now(),
      });
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
