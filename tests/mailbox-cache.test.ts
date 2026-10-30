/**
 * Mailboxes held between reads: one store read per seat until the store says
 * that seat's mail changed, and never a stale mailbox kept from a read that
 * a write overtook.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { heldMailbox } from "../src/main/junto/work/mailbox-cache";
import type { WorkChange } from "../src/main/junto/work/projection-changes";
import { WorkRepository } from "../src/main/junto/work/repository";
import { WorkService } from "../src/main/junto/work/service";
import type { Message } from "../src/shared/work-model";

type Listener = (canvasName: string, nodeId: string, kind?: "mail" | "work", change?: WorkChange) => void;

/** A delivery, read or ack receipt on one message, as the store announces it. */
const receipt = (messageId: string, stamp: "deliveredAt" | "readAt" | "ack", at: number): WorkChange => ({
  stamp: { messageId, stamp, at },
});

const row = (messageId: string): Message => ({ messageId, role: "user", parts: [{ kind: "text", text: messageId }] });

const fixture = () => {
  const state = { reads: 0, stored: [row("a")], duringRead: undefined as (() => void) | undefined };
  const listeners = new Set<Listener>();
  const repository = {
    subscribeChanges: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const work = {
    readMailbox: () =>
      Effect.sync(() => {
        state.reads += 1;
        const snapshot = [...state.stored];
        state.duringRead?.();
        return snapshot;
      }),
  };
  const read = (canvas: string, node: string) =>
    Effect.runPromise(
      heldMailbox(canvas, node).pipe(
        Effect.provideService(WorkRepository, repository as never),
        Effect.provideService(WorkService, work as never),
      ),
    );
  const announce: Listener = (canvas, node, kind, change) =>
    listeners.forEach((listener) => listener(canvas, node, kind, change));
  return { state, read, announce, listeners };
};

describe("held mailboxes", () => {
  it("reads the store once per seat and serves the rest from what it holds", async () => {
    const { state, read } = fixture();
    expect(await read("factory", "seat-1")).toHaveLength(1);
    await read("factory", "seat-1");
    await read("factory", "seat-1");
    expect(state.reads).toBe(1);
    await read("factory", "seat-2");
    expect(state.reads).toBe(2);
  });

  it("reads again after that seat's mail changed, and only that seat's", async () => {
    const { state, read, announce } = fixture();
    await read("factory", "seat-1");
    await read("factory", "seat-2");
    state.stored = [row("a"), row("b")];
    announce("factory", "seat-1", "mail");
    expect(await read("factory", "seat-1")).toHaveLength(2);
    expect(state.reads).toBe(3);
    await read("factory", "seat-2");
    expect(state.reads).toBe(3);
    // The same seat name in another canvas is another mailbox.
    announce("other", "seat-2", "mail");
    await read("factory", "seat-2");
    expect(state.reads).toBe(3);
  });

  it("holds through work changes, which are not mail", async () => {
    const { state, read, announce } = fixture();
    await read("factory", "seat-1");
    announce("factory", "seat-1", "work");
    await read("factory", "seat-1");
    expect(state.reads).toBe(1);
  });

  it("does not keep a read that a write overtook", async () => {
    const { state, read, announce } = fixture();
    state.duringRead = () => {
      state.duringRead = undefined;
      announce("factory", "seat-1", "mail");
    };
    await read("factory", "seat-1");
    state.stored = [row("a"), row("b")];
    expect(await read("factory", "seat-1")).toHaveLength(2);
    expect(state.reads).toBe(2);
  });

  it("restamps the row a receipt names, and reads nothing", async () => {
    const { state, read, announce } = fixture();
    await read("factory", "seat-1");
    announce("factory", "seat-1", "mail", receipt("a", "deliveredAt", 1_763_000_000_000));
    const [held] = await read("factory", "seat-1");
    expect(held?.metadata).toMatchObject({ deliveredAt: 1_763_000_000_000 });
    expect(state.reads).toBe(1);
    // A read stamp lands beside the delivery one, and an ack as the store reads a reaction.
    announce("factory", "seat-1", "mail", receipt("a", "readAt", 1_763_000_000_001));
    announce("factory", "seat-1", "mail", receipt("a", "ack", 1_763_000_000_002));
    const [stamped] = await read("factory", "seat-1");
    expect(stamped?.metadata).toMatchObject({
      deliveredAt: 1_763_000_000_000,
      readAt: 1_763_000_000_001,
      reactions: [{ kind: "ack", at: 1_763_000_000_002 }],
    });
    expect(state.reads).toBe(1);
  });

  it("stamps the receipts that landed during a read onto the rows it returned", async () => {
    const { state, read, announce } = fixture();
    state.duringRead = () => {
      state.duringRead = undefined;
      announce("factory", "seat-1", "mail", receipt("a", "readAt", 1_763_000_000_003));
    };
    const [held] = await read("factory", "seat-1");
    expect(held?.metadata).toMatchObject({ readAt: 1_763_000_000_003 });
    expect(state.reads).toBe(1);
    expect(await read("factory", "seat-1")).toEqual([expect.objectContaining({ metadata: { readAt: 1_763_000_000_003 } })]);
  });

  it("leaves the held rows alone for a receipt of a message it does not hold", async () => {
    const { state, read, announce } = fixture();
    await read("factory", "seat-1");
    announce("factory", "seat-1", "mail", receipt("gone", "readAt", 1_763_000_000_004));
    const [held] = await read("factory", "seat-1");
    expect(held?.metadata).toBeUndefined();
    expect(state.reads).toBe(1);
  });

  it("subscribes once per repository", async () => {
    const { read, listeners } = fixture();
    await read("factory", "seat-1");
    await read("factory", "seat-2");
    expect(listeners.size).toBe(1);
  });
});
