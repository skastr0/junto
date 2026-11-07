/**
 * Mailboxes held between reads, for the Threads popup and the phone's
 * threads. A page of threads needs every agent seat's mail, and reading that
 * from the store is most of what a page costs (about 130 ms of 175 on a
 * 15,000-mail canvas), once per page and again on every mail change. So a
 * mailbox is read once and kept until the store says its seat's mail changed.
 *
 * The store announces every write to a seat's mail after it commits
 * (`subscribeChanges`, kind "mail"; a canvas or seat removal announces its
 * deleted mail the same way). A read that began before an announcement is not
 * kept, so a write landing mid-read can never leave a stale mailbox behind.
 * A delivery or read receipt is not such a write: it restamps one message the
 * change names, so the held rows keep their place and the stamp is merged in,
 * with no read at all. Only mail is held: nothing here is written back.
 */
import { Effect } from "effect";
import type { Message } from "@shared/work-model";
import type { MailboxStampChange } from "./projection-changes";
import { WorkRepository, type WorkRepositoryShape } from "./repository";
import { WorkService } from "./service";

type Slot = {
  messages?: ReadonlyArray<Message>;
  generation: number;
  /** Receipts that landed since these rows were read, by message and stamp. */
  readonly stamps: Map<string, MailboxStampChange>;
};

const slotKey = (canvasName: string, nodeId: string): string => `${canvasName}\u0000${nodeId}`;

const stampKey = (stamp: MailboxStampChange): string => `${stamp.messageId}\u0000${stamp.stamp}`;

/** One row as the store stamps it (`messageWithReceipts`), with one receipt merged in. */
const withStamp = (row: Message, stamp: MailboxStampChange): Message => ({
  ...row,
  metadata: {
    ...row.metadata,
    ...(stamp.stamp === "ack" ? { reactions: [{ kind: "ack", at: stamp.at }] } : { [stamp.stamp]: stamp.at }),
  },
});

/**
 * The held rows with the receipts that landed since they were read merged in,
 * as the store reads them; undefined when none of those receipts names one.
 */
const withStamps = (
  messages: ReadonlyArray<Message>,
  stamps: ReadonlyMap<string, MailboxStampChange>,
): ReadonlyArray<Message> | undefined => {
  if (stamps.size === 0) return undefined;
  const at = new Map(messages.map((row, index) => [row.messageId, index]));
  let out: Message[] | undefined;
  for (const stamp of stamps.values()) {
    const index = at.get(stamp.messageId);
    if (index === undefined) continue;
    out ??= [...messages];
    out[index] = withStamp(out[index]!, stamp);
  }
  return out;
};

/** One cache per repository, subscribed when first used and for as long as the repository lives. */
const caches = new WeakMap<object, Map<string, Slot>>();

const cacheOf = (repository: WorkRepositoryShape): Map<string, Slot> => {
  let held = caches.get(repository);
  if (held === undefined) {
    const slots = new Map<string, Slot>();
    held = slots;
    caches.set(repository, slots);
    repository.subscribeChanges((canvasName, nodeId, kind, change) => {
      if (kind === "work") return;
      const slot = slots.get(slotKey(canvasName, nodeId));
      if (slot === undefined) return;
      const stamp = change?.stamp;
      if (stamp !== undefined) {
        // A receipt restamps one message: the rows stay held, and the stamp rides them.
        slot.stamps.set(stampKey(stamp), stamp);
        return;
      }
      slot.generation += 1;
      delete slot.messages;
      slot.stamps.clear();
    });
  }
  return held;
};

/** A seat's mailbox: the held read with the receipts since merged in, kept for next time. */
export const heldMailbox = (canvasName: string, nodeId: string) =>
  Effect.gen(function* () {
    const slots = cacheOf(yield* WorkRepository);
    const key = slotKey(canvasName, nodeId);
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = { generation: 0, stamps: new Map() };
      slots.set(key, slot);
    }
    const held = slot.messages;
    if (held !== undefined) {
      const stamped = withStamps(held, slot.stamps) ?? held;
      slot.messages = stamped;
      slot.stamps.clear();
      return stamped;
    }
    const began = slot.generation;
    const messages = yield* (yield* WorkService).readMailbox(canvasName, nodeId);
    if (slot.generation === began) {
      // Receipts that landed during the read name rows it holds: they ride it.
      const stamped = withStamps(messages, slot.stamps) ?? messages;
      slot.messages = stamped;
      slot.stamps.clear();
      return stamped;
    }
    return messages;
  });
