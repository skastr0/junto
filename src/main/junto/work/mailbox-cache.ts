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
 * Only mail is held: nothing here is written back.
 */
import { Effect } from "effect";
import type { Message } from "@shared/work-model";
import { WorkRepository, type WorkRepositoryShape } from "./repository";
import { WorkService } from "./service";

type Slot = { messages?: ReadonlyArray<Message>; generation: number };

const slotKey = (canvasName: string, nodeId: string): string => `${canvasName}\u0000${nodeId}`;

/** One cache per repository, subscribed when first used and for as long as the repository lives. */
const caches = new WeakMap<object, Map<string, Slot>>();

const cacheOf = (repository: WorkRepositoryShape): Map<string, Slot> => {
  let held = caches.get(repository);
  if (held === undefined) {
    const slots = new Map<string, Slot>();
    held = slots;
    caches.set(repository, slots);
    repository.subscribeChanges((canvasName, nodeId, kind) => {
      if (kind === "work") return;
      const slot = slots.get(slotKey(canvasName, nodeId));
      if (slot === undefined) return;
      slot.generation += 1;
      delete slot.messages;
    });
  }
  return held;
};

/** A seat's mailbox: the held read, or the store's, kept for next time. */
export const heldMailbox = (canvasName: string, nodeId: string) =>
  Effect.gen(function* () {
    const slots = cacheOf(yield* WorkRepository);
    const key = slotKey(canvasName, nodeId);
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = { generation: 0 };
      slots.set(key, slot);
    }
    if (slot.messages !== undefined) return slot.messages;
    const began = slot.generation;
    const messages = yield* (yield* WorkService).readMailbox(canvasName, nodeId);
    if (slot.generation === began) slot.messages = messages;
    return messages;
  });
