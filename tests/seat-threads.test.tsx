// @vitest-environment jsdom
/**
 * A seat's threads in its open view: a plain Threads button (mail has no
 * operator read state, so it counts nothing); the popup lists the seat's
 * threads in two groups and shows one as a chat, oldest first, the operator's
 * own on the right. A thread between seats is read only. The data comes
 * from main's threads IPC and is read again on any mail change in the canvas.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailThreadMessage, MailThreadSummary } from "../src/shared/wire/mail-threads";
import {
  betweenLine,
  groupSeatThreads,
  participantsLine,
  resetSeatThreads,
  setSeatThreadsSource,
  type SeatThreadMessage,
  type SeatThreadsSource,
  type SeatThreadSummary,
} from "../src/renderer/lib/seat-threads";
import { SeatThreadsButton } from "../src/renderer/components/threads/SeatThreads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEAT = { canvasName: "factory", seatId: "seat-1" };
const at = (hours: number, minutes: number) => new Date(2026, 9, 19, hours, minutes).getTime();

const thread = (over: Partial<SeatThreadSummary> & { threadId: string }): SeatThreadSummary => ({
  title: over.threadId,
  participants: ["you", "pty-lead"],
  startedAt: at(1, 2),
  lastAt: at(1, 12),
  messageCount: 2,
  canReply: true,
  ...over,
});

const notes = thread({
  threadId: "notes",
  title: "Session notes out of ~/.junto: get it done now",
  participants: ["you", "pty-lead", "product-lead"],
});
const banner = thread({ threadId: "banner", title: "Cache banner: look A, under the header", lastAt: at(0, 58) });
const reader = thread({
  threadId: "reader",
  title: "Reader switch for the onboard answer",
  participants: ["cli-lead", "pty-lead"],
  lastAt: at(0, 44),
  canReply: false,
});

const fake = () => {
  const listeners = new Set<(change: { canvasName: string; seatId?: string }) => void>();
  const state = {
    threads: [notes, banner, reader] as SeatThreadSummary[],
    messages: {
      notes: [
        { messageId: "m1", author: "you", mine: true, text: "Move them into junto.db.", at: at(1, 2) },
        { messageId: "m2", author: "pty-lead", mine: false, text: "On it.", at: at(1, 4) },
      ],
      reader: [{ messageId: "r1", author: "cli-lead", mine: false, text: "Switch the reader.", at: at(0, 31) }],
    } as Record<string, SeatThreadMessage[]>,
    lists: 0,
  };
  const source: SeatThreadsSource = {
    list: async () => {
      state.lists += 1;
      return state.threads;
    },
    messages: async ({ threadId }) => state.messages[threadId] ?? [],
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const change = (seatId?: string) => listeners.forEach((listener) => listener({ canvasName: "factory", seatId }));
  return { state, source, change, listeners };
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetSeatThreads();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetSeatThreads();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

const render = async () => {
  act(() => root.render(<SeatThreadsButton seat={SEAT} name="pty-lead" />));
  await flush();
};

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const all = (testId: string) => [...document.querySelectorAll(`[data-testid="${testId}"]`)];
const click = async (element: Element | null) => {
  act(() => (element as HTMLElement).click());
  await flush();
};

describe("the seat's threads, in words", () => {
  it("groups with you and between seats, newest first", () => {
    const groups = groupSeatThreads([banner, reader, notes]);
    expect(groups.withYou.map((item) => item.threadId)).toEqual(["notes", "banner"]);
    expect(groups.betweenSeats.map((item) => item.threadId)).toEqual(["reader"]);
  });

  it("names who is in a thread", () => {
    expect(participantsLine(["you", "pty-lead", "product-lead"])).toBe("you, pty-lead, +1");
    expect(participantsLine(["cli-lead", "pty-lead"])).toBe("cli-lead, pty-lead");
    expect(betweenLine(["cli-lead", "pty-lead"])).toBe("Between cli-lead and pty-lead.");
    expect(betweenLine(["a", "b", "c"])).toBe("Between a, b and c.");
  });
});

describe("the Threads button", () => {
  it("is plain, with no count and no new mark", async () => {
    const { source } = fake();
    setSeatThreadsSource(source);
    await render();
    expect(q("seat-threads-button")?.textContent).toBe("Threads");
    await click(q("seat-threads-button"));
    expect(document.querySelector("[data-testid=seat-threads] [aria-hidden][style]")).toBeNull();
  });
});

describe("main's threads IPC as the source", () => {
  afterEach(() => {
    delete (window as { junto?: unknown }).junto;
  });

  it("names parties, reads a seat's threads and messages, and reads again on any mail change in the canvas", async () => {
    const operator = { kind: "operator" } as const;
    const ptyLead = { kind: "seat", nodeId: "seat-1", name: "pty-lead" } as const;
    const first: MailThreadMessage = {
      messageId: "m1", threadId: "t1", from: operator, to: [ptyLead], mine: true, text: "Move them.", at: at(1, 2),
    };
    const summary: MailThreadSummary = {
      threadId: "t1", title: "Move them.", participants: [operator, ptyLead], startedAt: at(1, 2), lastAt: at(1, 2),
      last: first, messageCount: 1, canReply: true,
    };
    const mail = new Set<(event: { canvasName: string; nodeId: string }) => void>();
    const seatThreadsList = vi.fn(async () => [summary]);
    (window as { junto?: unknown }).junto = {
      seatThreadsList,
      seatThreadMessages: vi.fn(async () => [first]),
      onWorkMailChanged: (listener: (event: { canvasName: string; nodeId: string }) => void) => {
        mail.add(listener);
        return () => mail.delete(listener);
      },
    };
    await render();
    await click(q("seat-threads-button"));
    expect(seatThreadsList).toHaveBeenCalledWith({ canvasName: "factory", nodeId: "seat-1" });
    expect(q("seat-threads-with-you")?.textContent).toContain("you, pty-lead");
    expect(all("seat-threads-message")[0]?.textContent).toContain("you 01:02");
    // A change in another seat's mailbox can change this seat's threads.
    const calls = seatThreadsList.mock.calls.length;
    mail.forEach((listener) => listener({ canvasName: "factory", nodeId: "seat-9" }));
    await flush();
    expect(seatThreadsList.mock.calls.length).toBeGreaterThan(calls);
    const settled = seatThreadsList.mock.calls.length;
    mail.forEach((listener) => listener({ canvasName: "other", nodeId: "seat-1" }));
    await flush();
    expect(seatThreadsList.mock.calls.length).toBe(settled);
  });
});

describe("the Threads popup", () => {
  const open = async () => {
    const fixture = fake();
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    return fixture;
  };

  it("lists the seat's threads in two groups under New thread", async () => {
    await open();
    expect(q("seat-threads")).not.toBeNull();
    expect(q("seat-threads-new")?.textContent).toContain("New thread");
    const withYou = q("seat-threads-with-you")!;
    const between = q("seat-threads-between-seats")!;
    expect([...withYou.querySelectorAll("[data-thread-id]")].map((row) => row.getAttribute("data-thread-id"))).toEqual([
      "notes",
      "banner",
    ]);
    expect([...between.querySelectorAll("[data-thread-id]")].map((row) => row.getAttribute("data-thread-id"))).toEqual([
      "reader",
    ]);
    expect(withYou.textContent).toContain("you, pty-lead, +1");
    expect(withYou.textContent).toContain("01:12");
  });

  it("opens on the newest thread with you, oldest first, the operator's own on the right", async () => {
    await open();
    const messages = all("seat-threads-message");
    expect(messages.map((message) => message.querySelector(".seat-threads__bubble")?.textContent)).toEqual([
      "Move them into junto.db.",
      "On it.",
    ]);
    expect(messages[0]?.getAttribute("data-mine")).toBe("true");
    expect(messages[1]?.getAttribute("data-mine")).toBeNull();
    expect(q("thread-composer")?.getAttribute("data-mode")).toBe("reply");
    expect(q("seat-threads-readonly")).toBeNull();
  });

  it("shows a thread between seats read only, with no composer and a line saying why", async () => {
    await open();
    await click(document.querySelector('[data-thread-id="reader"]'));
    expect(q("thread-composer")).toBeNull();
    expect(q("seat-threads-readonly")?.textContent).toBe(
      "read onlyBetween cli-lead and pty-lead. You are not in this thread, so you read it and do not write in it.",
    );
  });

  it("starts a new thread in the composer", async () => {
    await open();
    await click(q("seat-threads-new"));
    expect(q("thread-composer")?.getAttribute("data-mode")).toBe("new");
    expect(q("seat-threads")?.textContent).toContain("Its first line becomes the thread's name in the list.");
  });

  it("reads an open thread again when its seat's threads change", async () => {
    const { state, change } = await open();
    state.messages.notes = [
      ...state.messages.notes!,
      { messageId: "m3", author: "pty-lead", mine: false, text: "Landed.", at: at(1, 12) },
    ];
    change("seat-1");
    await flush();
    expect(all("seat-threads-message")).toHaveLength(3);
  });

  it("closes and lets go of the source when nothing holds it", async () => {
    const { listeners } = await open();
    await click(document.querySelector('[aria-label="Close threads"]'));
    expect(q("seat-threads")).toBeNull();
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(host);
  });
});

describe("the thread composer", () => {
  const sends: unknown[] = [];
  let reply: unknown = { ok: true, messageId: "m9", threadId: "notes", delivery: [] };

  beforeEach(() => {
    sends.length = 0;
    reply = { ok: true, messageId: "m9", threadId: "notes", delivery: [] };
    (window as { junto?: unknown }).junto = {
      seatThreadMentionables: async () => [
        { nodeId: "seat-cli", name: "cli-lead" },
        { nodeId: "seat-canvas", name: "canvas-lead" },
      ],
      seatThreadSend: async (input: unknown) => {
        sends.push(input);
        return reply;
      },
    };
  });

  afterEach(() => {
    delete (window as { junto?: unknown }).junto;
  });

  const open = async () => {
    const fixture = fake();
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    return fixture;
  };

  const field = () => q("thread-composer-input") as HTMLTextAreaElement;
  const type = async (value: string) => {
    const element = field();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, value);
      element.setSelectionRange(value.length, value.length);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
  };
  const key = async (name: string, init: KeyboardEventInit = {}) => {
    act(() => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
    });
    await flush();
  };

  it("sends a reply on Enter, in reply to the thread's last mail, and clears the draft", async () => {
    await open();
    await type("Thanks.");
    await key("Enter", { shiftKey: true });
    expect(sends).toEqual([]);
    await key("Enter");
    expect(sends).toEqual([{ canvasName: "factory", nodeId: "seat-1", text: "Thanks.", inReplyTo: "m2" }]);
    expect(field().value).toBe("");
  });

  it("opens the wired seats on @, puts the chosen one in the draft and in mentions", async () => {
    await open();
    await type("Thanks. @c");
    expect(all("thread-composer-option").map((option) => option.textContent)).toEqual(["cli-lead", "canvas-lead"]);
    await key("ArrowDown");
    await key("Enter");
    expect(field().value).toBe("Thanks. @canvas-lead ");
    expect(q("thread-composer-picker")).toBeNull();
    expect(sends).toEqual([]);
    await key("Enter");
    expect(sends).toEqual([
      { canvasName: "factory", nodeId: "seat-1", text: "Thanks. @canvas-lead", inReplyTo: "m2", mentions: ["seat-canvas"] },
    ]);
  });

  it("closes the @ list on Escape and leaves the popup open", async () => {
    await open();
    await type("@c");
    await key("Escape");
    expect(q("thread-composer-picker")).toBeNull();
    expect(q("seat-threads")).not.toBeNull();
  });

  it("shows a refusal as is and keeps the draft", async () => {
    await open();
    reply = { ok: false, reason: "invalid", message: "dev-lead is not wired to pty-lead." };
    await type("Hello @dev-lead");
    await key("Enter");
    expect(q("thread-composer-failure")?.textContent).toBe("dev-lead is not wired to pty-lead.");
    expect(field().value).toBe("Hello @dev-lead");
  });

  it("starts a new thread with no parent and selects the thread it made", async () => {
    const { state, change } = await open();
    await click(q("seat-threads-new"));
    expect(q("thread-composer")?.getAttribute("data-mode")).toBe("new");
    reply = { ok: true, messageId: "fresh", threadId: "fresh", delivery: [] };
    await type("The loader's start phase reads starting session.");
    await click(q("thread-composer-send"));
    expect(sends.at(-1)).toEqual({
      canvasName: "factory",
      nodeId: "seat-1",
      text: "The loader's start phase reads starting session.",
    });
    state.threads = [thread({ threadId: "fresh", title: "The loader's start phase", lastAt: at(2, 0) }), ...state.threads];
    state.messages.fresh = [{ messageId: "fresh", author: "you", mine: true, text: "The loader's start phase.", at: at(2, 0) }];
    change();
    await flush();
    expect(document.querySelector('[data-thread-id="fresh"]')?.getAttribute("data-selected")).toBe("true");
    expect(q("thread-composer")?.getAttribute("data-mode")).toBe("reply");
  });
});

