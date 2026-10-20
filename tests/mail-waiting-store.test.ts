import { afterEach, describe, expect, it } from "vitest";
import type { MailWaitingFact } from "../src/shared/mail-waiting";
import {
  applyMailWaitingFact,
  mailWaiting$,
  mailWaitsOn,
  startMailWaitingWatch,
} from "../src/renderer/lib/mail-waiting";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  mailWaiting$.set({});
});

describe("the mail-waiting store", () => {
  it("keeps one wait per seat and clears it on a count of none", () => {
    applyMailWaitingFact({ canvasName: "main", nodeId: "a", count: 2, heldSince: 1_000, hold: "draft" });
    applyMailWaitingFact({ canvasName: "main", nodeId: "a", count: 3, heldSince: 1_000, hold: "dialog" });
    applyMailWaitingFact({ canvasName: "main", nodeId: "b", count: 1, heldSince: 2_000, hold: "unreadable" });
    expect(mailWaitsOn(mailWaiting$.peek(), "main")).toEqual(
      new Map([
        ["a", { count: 3, heldSince: 1_000, hold: "dialog" }],
        ["b", { count: 1, heldSince: 2_000, hold: "unreadable" }],
      ]),
    );
    applyMailWaitingFact({ canvasName: "main", nodeId: "a", count: 0 });
    expect([...mailWaitsOn(mailWaiting$.peek(), "main").keys()]).toEqual(["b"]);
    expect(mailWaitsOn(mailWaiting$.peek(), "other").size).toBe(0);
  });

  it("reads the facts that stand, and a seat told while the read was out keeps what it was told", async () => {
    let tell: ((fact: MailWaitingFact) => void) | undefined;
    let answer: ((facts: ReadonlyArray<MailWaitingFact>) => void) | undefined;
    const stop = startMailWaitingWatch({
      onMailWaiting: (listener: (fact: MailWaitingFact) => void) => {
        tell = listener;
        return () => {
          tell = undefined;
        };
      },
      mailWaiting: () => new Promise((resolve) => (answer = resolve)),
    });
    tell!({ canvasName: "main", nodeId: "a", count: 0 });
    answer!([
      { canvasName: "main", nodeId: "a", count: 4, heldSince: 1_000, hold: "draft" },
      { canvasName: "main", nodeId: "b", count: 1, heldSince: 2_000, hold: "dialog" },
    ]);
    await flush();
    expect([...mailWaitsOn(mailWaiting$.peek(), "main").keys()]).toEqual(["b"]);
    stop();
    expect(tell).toBeUndefined();
  });

  it("lets a later read replace what the store held, and keeps no reason this build cannot word", async () => {
    applyMailWaitingFact({ canvasName: "main", nodeId: "gone", count: 2, heldSince: 1_000, hold: "draft" });
    const stop = startMailWaitingWatch({
      mailWaiting: async () => [
        { canvasName: "main", nodeId: "a", count: 1, heldSince: 1_000, hold: "draft" },
        { canvasName: "main", nodeId: "new", count: 1, heldSince: 1_000, hold: "a newer reason" as never },
      ],
    });
    await flush();
    expect([...mailWaitsOn(mailWaiting$.peek(), "main").keys()]).toEqual(["a"]);
    applyMailWaitingFact({ canvasName: "main", nodeId: "b", count: 1, heldSince: 1_000, hold: "toString" as never });
    expect(mailWaitsOn(mailWaiting$.peek(), "main").has("b")).toBe(false);
    stop();
  });

  it("does nothing on a bridge with neither method", () => {
    const stop = startMailWaitingWatch({});
    stop();
    expect(mailWaiting$.peek()).toEqual({});
  });
});
