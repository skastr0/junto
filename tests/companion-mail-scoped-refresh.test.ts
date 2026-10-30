/**
 * A phone following a seat's threads made the Mac re-read every followed
 * seat's threads and mail on every change, so on a busy canvas seat state and
 * awareness alone kept the 0.11.4 main thread reading the database back to
 * back (73% of main in StatementSync.all) and the phone's ping went late. The
 * change clock now marks the bumps that can change a thread or a mailbox, and
 * a session reads them again only after one of those.
 */
import { describe, expect, it } from "vitest";
import { makeCompanionChanges } from "../src/main/junto/companion/changes";
import { runCompanionSession, type CompanionChange } from "../src/shared/companion-session";
import { COMPANION_PROTOCOL, type CompanionRequestFrame, type CompanionResponseFrame } from "../src/shared/wire/companion-protocol";

describe("the companion change clock", () => {
  it("marks a poll as mail only after a mail-scoped bump", async () => {
    const changes = makeCompanionChanges();
    const first = await changes.wait(undefined, 0);
    changes.bump();
    const state = await changes.wait(first.cursor, 0);
    expect(state).toMatchObject({ changed: true, mail: false });
    changes.bump("mail");
    changes.bump();
    const mail = await changes.wait(state.cursor, 0);
    expect(mail).toMatchObject({ changed: true, mail: true });
  });
});

const lineFeed = () => {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        return { done: true, value: undefined };
      },
      return: async () => ({ done: true, value: undefined }),
    }),
  };
  const push = (line: string): void => {
    queue.push(line);
    wake?.();
    wake = undefined;
  };
  return { lines, push, end: () => { ended = true; wake?.(); wake = undefined; } };
};

const settle = async (times = 5): Promise<void> => {
  for (let at = 0; at < times; at += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("a session following a seat's threads", () => {
  it("reads them again after a mail change, not after a seat state change", async () => {
    const io = lineFeed();
    const reads: string[] = [];
    let release: (() => void) | undefined;
    let polled: CompanionChange = { cursor: "c1", changed: false, signals: [], reset: false };
    const host = {
      hello: async () => ({
        ok: true as const,
        hello: { appVersion: "0.11.7", deviceId: "dev", deviceName: "Test phone", station: "Test Mac", protocol: COMPANION_PROTOCOL, serverTime: 0, features: [] },
      }),
      call: async (frame: CompanionRequestFrame): Promise<CompanionResponseFrame> => {
        reads.push(frame.op);
        const result = frame.op === "threads.list" ? { threads: [] } : {};
        return { v: COMPANION_PROTOCOL, type: "response", id: frame.id, ok: true, result } as CompanionResponseFrame;
      },
      waitChange: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return polled;
      },
    };
    const running = runCompanionSession({ lines: io.lines, write: () => undefined, host, idleCloseMs: 5_000, waitMs: 0 });
    io.push(JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id: "t1", op: "threads.list", args: { canvasName: "demo", nodeId: "seat-a" } }));
    await settle();
    // The first poll reads once against what was answered.
    polled = { cursor: "c2", changed: true, signals: [], reset: false };
    release?.();
    await settle();
    const threadReads = () => reads.filter((op) => op === "threads.list").length;
    const afterFirst = threadReads();

    polled = { cursor: "c3", changed: true, signals: [], mail: false, reset: false };
    release?.();
    await settle();
    expect(threadReads()).toBe(afterFirst);

    polled = { cursor: "c4", changed: true, signals: [], mail: true, reset: false };
    release?.();
    await settle();
    expect(threadReads()).toBe(afterFirst + 1);

    // An older Mac sends no mark: it may have changed, so the session reads.
    polled = { cursor: "c5", changed: true, signals: [], reset: false };
    release?.();
    await settle();
    expect(threadReads()).toBe(afterFirst + 2);
    io.end();
    release?.();
    await running;
  });
});
