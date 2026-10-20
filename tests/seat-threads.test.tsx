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
import { MAIL_MENTIONS_MAX, OPERATOR_MAIL_MAX_TEXT } from "../src/shared/mail-threads";
import {
  THREAD_MENTIONS_MAX,
  THREAD_TEXT_MAX,
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
        { messageId: "m1", author: "you", mine: true, text: "Move them into junto.db.", mentions: [], at: at(1, 2) },
        { messageId: "m2", author: "pty-lead", mine: false, text: "On it.", mentions: [], at: at(1, 4) },
      ],
      reader: [{ messageId: "r1", author: "cli-lead", mine: false, text: "Switch the reader.", mentions: [], at: at(0, 31) }],
    } as Record<string, SeatThreadMessage[]>,
    lists: 0,
  };
  const source: SeatThreadsSource = {
    list: async () => {
      state.lists += 1;
      return { threads: state.threads };
    },
    messages: async ({ threadId }) => ({ messages: state.messages[threadId] ?? [] }),
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

  it("holds main's bounds on operator mail", () => {
    expect(THREAD_TEXT_MAX).toBe(OPERATOR_MAIL_MAX_TEXT);
    expect(THREAD_MENTIONS_MAX).toBe(MAIL_MENTIONS_MAX);
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
      messageId: "m1", threadId: "t1", from: operator, to: [ptyLead], mine: true, text: "Move them, @cli-lead.", at: at(1, 2),
      mentions: [{ kind: "seat", nodeId: "seat-cli", name: "cli-lead" }],
    };
    const summary: MailThreadSummary = {
      threadId: "t1", title: "Move them.", participants: [operator, ptyLead], startedAt: at(1, 2), lastAt: at(1, 2),
      last: first, messageCount: 1, canReply: true,
    };
    const mail = new Set<(event: { canvasName: string; nodeId: string }) => void>();
    const seatThreadsList = vi.fn(async () => ({ threads: [summary] }));
    (window as { junto?: unknown }).junto = {
      seatThreadsList,
      seatThreadMessages: vi.fn(async () => ({ messages: [first] })),
      onWorkMailChanged: (listener: (event: { canvasName: string; nodeId: string }) => void) => {
        mail.add(listener);
        return () => mail.delete(listener);
      },
    };
    await render();
    await click(q("seat-threads-button"));
    expect(seatThreadsList).toHaveBeenCalledWith({ canvasName: "factory", nodeId: "seat-1", limit: 50 });
    expect(q("seat-threads-with-you")?.textContent).toContain("you, pty-lead");
    expect(all("seat-threads-message")[0]?.textContent).toContain("you 01:02");
    expect(all("seat-threads-mention").map((mention) => mention.textContent)).toEqual(["@cli-lead"]);
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
      { messageId: "m3", author: "pty-lead", mine: false, text: "Landed.", mentions: [], at: at(1, 12) },
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
  let reply: unknown = { ok: true, messageId: "m9", threadId: "notes", delivery: "delivered" };

  beforeEach(() => {
    sends.length = 0;
    reply = { ok: true, messageId: "m9", threadId: "notes", delivery: "delivered" };
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

  it("opens the wired seats on @, puts the chosen one in the draft and in mentions, never in To", async () => {
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
    await type("Check it, @canvas-lead");
    await key("Enter");
    expect(q("thread-composer-to")?.textContent).toBe("Topty-lead");
    reply = { ok: true, messageId: "fresh", threadId: "fresh", delivery: "delivered" };
    await type("The loader's start phase reads starting session.");
    sends.length = 0;
    await click(q("thread-composer-send"));
    expect(sends.at(-1)).toEqual({
      canvasName: "factory",
      nodeId: "seat-1",
      text: "The loader's start phase reads starting session.",
    });
    state.threads = [thread({ threadId: "fresh", title: "The loader's start phase", lastAt: at(2, 0) }), ...state.threads];
    state.messages.fresh = [{ messageId: "fresh", author: "you", mine: true, text: "The loader's start phase.", mentions: [], at: at(2, 0) }];
    change();
    await flush();
    expect(document.querySelector('[data-thread-id="fresh"]')?.getAttribute("data-selected")).toBe("true");
    expect(q("thread-composer")?.getAttribute("data-mode")).toBe("reply");
  });

  it("shows an @name in a message as a reference, not a participant", async () => {
    const { state, change } = await open();
    state.messages.notes = [
      {
        messageId: "m1",
        author: "you",
        mine: true,
        text: "Thanks. @cli-lead check it, and @pty-lead or @nobody.",
        mentions: ["cli-lead"],
        at: at(1, 2),
      },
    ];
    change();
    await flush();
    expect(all("seat-threads-mention").map((mention) => mention.textContent)).toEqual(["@cli-lead"]);
    expect(all("seat-threads-message")[0]?.querySelector(".seat-threads__bubble")?.textContent).toBe(
      "Thanks. @cli-lead check it, and @pty-lead or @nobody.",
    );
    expect(q("seat-threads")?.querySelector(".seat-threads__chat-meta")?.textContent).not.toContain("cli-lead");
  });

  it("will not send past main's text bound, and says so", async () => {
    await open();
    await type("x".repeat(THREAD_TEXT_MAX + 1));
    await key("Enter");
    expect(sends).toEqual([]);
    expect(q("thread-composer-failure")?.textContent).toBe(`${THREAD_TEXT_MAX + 1} characters; a mail holds at most ${THREAD_TEXT_MAX}.`);
    expect((q("thread-composer-send") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("paging in the popup", () => {
  const ROW = 60;
  const VIEW = 600;
  const defined: Array<[PropertyKey, PropertyDescriptor | undefined]> = [];
  const define = (key: "scrollHeight" | "clientHeight", get: (this: HTMLElement) => number) => {
    defined.push([key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]);
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get });
  };

  beforeEach(() => {
    // jsdom lays nothing out: a row is ROW tall and the panes VIEW.
    define("scrollHeight", function () {
      const rows = this.querySelectorAll('[data-testid="seat-threads-row"]').length;
      return (rows > 0 ? rows : this.children.length) * ROW;
    });
    define("clientHeight", () => VIEW);
  });
  afterEach(() => {
    for (const [key, descriptor] of defined.splice(0).reverse()) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<PropertyKey, unknown>)[key];
    }
  });

  const TOTAL = 130;
  const threadAt = (n: number) => thread({ threadId: `t${String(n).padStart(3, "0")}`, lastAt: at(0, 0) + (TOTAL - n) * 1000 });
  const pagedSource = () => {
    const calls: Array<string | undefined> = [];
    const everything = Array.from({ length: TOTAL }, (_, n) => threadAt(n));
    const source: SeatThreadsSource = {
      list: async ({ after }) => {
        calls.push(after);
        const from = after === undefined ? 0 : everything.findIndex((item) => item.threadId === after) + 1;
        const threads = everything.slice(from, from + 50);
        const last = threads.at(-1);
        return { threads, ...(from + 50 < TOTAL && last ? { next: last.threadId } : {}) };
      },
      messages: async () => ({ messages: [] }),
      onChanged: () => () => undefined,
    };
    return { source, calls, everything };
  };

  it("reads one page of threads on open and the next as the list is scrolled near its end", async () => {
    const { source, calls } = pagedSource();
    setSeatThreadsSource(source);
    await render();
    await click(q("seat-threads-button"));
    expect(all("seat-threads-row")).toHaveLength(50);
    expect(calls).toEqual([undefined]);

    const list = document.querySelector<HTMLElement>(".seat-threads__list")!;
    // Far from the end: nothing more is asked for.
    list.scrollTop = 0;
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    expect(calls).toHaveLength(1);

    // Near the end: the next page, from the last thread read.
    list.scrollTop = list.scrollHeight - VIEW - 100;
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    expect(calls).toEqual([undefined, "t049"]);
    expect(all("seat-threads-row")).toHaveLength(100);
  });

  it("keeps the older pages when the head is read again after new mail", async () => {
    const { source, calls, everything } = pagedSource();
    setSeatThreadsSource(source);
    await render();
    await click(q("seat-threads-button"));
    const list = document.querySelector<HTMLElement>(".seat-threads__list")!;
    list.scrollTop = list.scrollHeight - VIEW - 100;
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    expect(all("seat-threads-row")).toHaveLength(100);

    // A thread older than the first page is lifted to the top: the head is read again.
    const lifted = everything[75]!;
    everything.splice(75, 1);
    everything.unshift({ ...lifted, lastAt: at(5, 0) });
    await act(async () => {
      const { refreshSeatThreads } = await import("../src/renderer/lib/seat-threads");
      refreshSeatThreads(SEAT);
    });
    await flush();
    const rows = all("seat-threads-row").map((row) => row.getAttribute("data-thread-id"));
    expect(rows).toHaveLength(100);
    expect(rows[0]).toBe(lifted.threadId);
    expect(new Set(rows).size).toBe(rows.length);
    expect(calls.at(-1)).toBeUndefined();
  });

  it("opens a long thread on its newest page and reads earlier ones keeping the place", async () => {
    const everything = Array.from({ length: 120 }, (_, n) => ({
      messageId: `m${String(n).padStart(3, "0")}`,
      author: "pty-lead",
      mine: false,
      text: `line ${n}`,
      mentions: [],
      at: at(0, 0) + n * 1000,
    }));
    const asked: Array<string | undefined> = [];
    const source: SeatThreadsSource = {
      list: async () => ({ threads: [thread({ threadId: "long", messageCount: 120 })] }),
      messages: async ({ before }) => {
        asked.push(before);
        const end = before === undefined ? everything.length : everything.findIndex((item) => item.messageId === before);
        const messages = everything.slice(Math.max(0, end - 50), end);
        return { messages, ...(end - 50 > 0 ? { older: messages[0]!.messageId } : {}) };
      },
      onChanged: () => () => undefined,
    };
    setSeatThreadsSource(source);
    await render();
    await click(q("seat-threads-button"));
    const stream = q("seat-threads-stream") as HTMLElement;
    const texts = () => all("seat-threads-message").map((message) => message.textContent ?? "");
    expect(texts()).toHaveLength(50);
    expect(texts().at(-1)).toContain("line 119");
    expect(asked).toEqual([undefined]);
    // On open it sits at the bottom, far from the top: nothing more asked for.
    expect(stream.scrollTop).toBe(stream.scrollHeight);

    stream.scrollTop = 10;
    const heightBefore = stream.scrollHeight;
    act(() => stream.dispatchEvent(new Event("scroll")));
    await flush();
    expect(asked).toEqual([undefined, "m070"]);
    expect(texts()).toHaveLength(100);
    expect(texts()[0]).toContain("line 20");
    // The fifty above pushed the same lines down by their height: the reader's place held.
    expect(stream.scrollTop).toBe(10 + (stream.scrollHeight - heightBefore));
  });
});
