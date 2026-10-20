/**
 * Mailboxes held between reads: one store read per seat until the store says
 * that seat's mail changed, and never a stale mailbox kept from a read that
 * a write overtook.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { heldMailbox } from "../src/main/junto/work/mailbox-cache";
import { WorkRepository } from "../src/main/junto/work/repository";
import { WorkService } from "../src/main/junto/work/service";
import type { Message } from "../src/shared/work-model";

type Listener = (canvasName: string, nodeId: string, kind?: "mail" | "work") => void;

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
  const announce: Listener = (canvas, node, kind) => listeners.forEach((listener) => listener(canvas, node, kind));
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

  it("subscribes once per repository", async () => {
    const { read, listeners } = fixture();
    await read("factory", "seat-1");
    await read("factory", "seat-2");
    expect(listeners.size).toBe(1);
  });
});
