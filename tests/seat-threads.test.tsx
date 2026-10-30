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
import { OPERATOR_MAIL_MAX_TEXT } from "../src/shared/mail-threads";
import {
  THREAD_TEXT_MAX,
  betweenLine,
  juntoSeatThreadsSource,
  previewText,
  groupSeatThreads,
  participantsLine,
  refreshSeatThreads,
  resetSeatThreads,
  setSeatThreadsSource,
  type SeatThreadMessage,
  type SeatThreadsSource,
  type SeatThreadSummary,
} from "../src/renderer/lib/seat-threads";
import { setOperatorContentPutter } from "../src/renderer/lib/operator-attachments";
import { SeatThreadsButton } from "../src/renderer/components/threads/SeatThreads";
import { asCanvasName } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { workDetailOpen$ } from "../src/renderer/lib/work-detail-open";
import { seat as seatNode, taskBoard } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver: a test fires the observed callbacks itself, as a layout change would.
const resized = new Set<() => void>();
globalThis.ResizeObserver = class {
  readonly fire: () => void;
  constructor(fire: () => void) {
    this.fire = fire;
  }
  observe() {
    resized.add(this.fire);
  }
  unobserve() {}
  disconnect() {
    resized.delete(this.fire);
  }
} as unknown as typeof ResizeObserver;

const SEAT = { canvasName: "factory", seatId: "seat-1" };
const at = (hours: number, minutes: number) => new Date(2026, 9, 19, hours, minutes).getTime();

const thread = (over: Partial<SeatThreadSummary> & { threadId: string }): SeatThreadSummary => ({
  title: over.threadId,
  participants: ["you", "pty-lead"],
  startedAt: at(1, 2),
  lastAt: at(1, 12),
  last: { messageId: `${over.threadId}-last`, author: "pty-lead", mine: false, text: over.threadId, at: at(1, 12) },
  messageCount: 2,
  canReply: true,
  unread: 0,
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
  const readListeners = new Set<(change: { canvasName: string; seatIds: ReadonlyArray<string> }) => void>();
  const marks: Array<{ readonly canvasName: string; readonly seatId: string; readonly threadId: string }> = [];
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
    /** Set to stand in for a seat with more threads than one page holds. */
    total: undefined as number | undefined,
    /** A count main could not read: it answers undefined, never zero. */
    countFails: false,
    counts: 0,
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
    // As main rules it: a mark moves the point, and marking a read thread writes nothing.
    markRead: async ({ canvasName, seatId, threadId }) => {
      marks.push({ canvasName, seatId, threadId });
      state.threads = state.threads.map((item) =>
        item.threadId === threadId && item.unread > 0 ? { ...item, unread: 0, readAt: at(2, 0) } : item,
      );
    },
    onReadChanged: (listener) => {
      readListeners.add(listener);
      return () => readListeners.delete(listener);
    },
    // The seat's total, over every thread it has: the page's rows are not the count.
    unreadTotal: async () => {
      state.counts += 1;
      if (state.countFails) return undefined;
      return state.total ?? state.threads.reduce((sum, item) => sum + item.unread, 0);
    },
  };
  const change = (seatId?: string) => listeners.forEach((listener) => listener({ canvasName: "factory", seatId }));
  /** The operator read on another device: the counts move, and the notice names the seats. */
  const readElsewhere = (threadId: string, seatIds: ReadonlyArray<string> = ["seat-1"]) => {
    state.threads = state.threads.map((item) => (item.threadId === threadId ? { ...item, unread: 0, readAt: at(2, 0) } : item));
    readListeners.forEach((listener) => listener({ canvasName: "factory", seatIds }));
  };
  return { state, source, change, listeners, marks, readListeners, readElsewhere };
};

let host: HTMLDivElement;
let root: Root;
let release: () => void;

beforeEach(() => {
  resetSeatThreads();
  // The seats and boards a mention link names: its chip reads the canvas for what it is now.
  release = modelStore.adopt({
    canvas: asCanvasName("factory"),
    seq: 0,
    wires: [],
    nodes: [seatNode("seat-cli", { label: "cli-lead", z: 0 }), taskBoard("board", { x: 400, z: 1 })],
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetSeatThreads();
  release();
  workDetailOpen$.set({ nodeId: "", itemId: "" });
});

const chipLabels = () => all("seat-threads-mention").map((mention) => mention.querySelector(".resource-chip__label")?.textContent);

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

  it("holds main's bound on operator mail", () => {
    expect(THREAD_TEXT_MAX).toBe(OPERATOR_MAIL_MAX_TEXT);
  });

  it("names who is in a thread", () => {
    expect(participantsLine(["you", "pty-lead", "product-lead"])).toBe("you, pty-lead, +1");
    expect(participantsLine(["cli-lead", "pty-lead"])).toBe("cli-lead, pty-lead");
    expect(betweenLine(["cli-lead", "pty-lead"])).toBe("Between cli-lead and pty-lead.");
    expect(betweenLine(["a", "b", "c"])).toBe("Between a, b and c.");
  });
});

describe("the Threads button", () => {
  it("counts what the operator has not read in a seat, and each row says its own", async () => {
    const fixture = fake();
    fixture.state.threads = [
      thread({ threadId: "notes", title: "Session notes", lastAt: at(1, 20) }),
      thread({ threadId: "banner", title: "Cache banner", lastAt: at(0, 58), unread: 2 }),
      thread({ threadId: "reader", title: "Reader switch", participants: ["cli-lead", "pty-lead"], lastAt: at(0, 44), canReply: false, unread: 1 }),
    ];
    setSeatThreadsSource(fixture.source);
    await render();
    expect(q("seat-threads-button")?.textContent).toBe("Threads3");
    expect(q("seat-threads-button")?.getAttribute("title")).toBe("Threads, 3 unread");

    await click(q("seat-threads-button"));
    const row = (threadId: string) => document.querySelector(`[data-thread-id="${threadId}"]`);
    expect(row("banner")?.querySelector('[data-testid="seat-threads-row-unread"]')?.textContent).toBe("2");
    expect(row("reader")?.querySelector('[data-testid="seat-threads-row-unread"]')?.textContent).toBe("1");
    // The thread the popup opened on has nothing unread, so its row says nothing.
    expect(row("notes")?.querySelector('[data-testid="seat-threads-row-unread"]')).toBeNull();
  });

  it("reads the count alone while the popup is shut, and the list once it opens", async () => {
    const fixture = fake();
    setSeatThreadsSource(fixture.source);
    await render();
    const lists = fixture.state.lists;
    const counts = fixture.state.counts;
    // A mailbox changed: the button's number follows, and no list is read for a popup that is not showing.
    act(() => fixture.change());
    await flush();
    expect(fixture.state.lists).toBe(lists);
    expect(fixture.state.counts).toBeGreaterThan(counts);

    await click(q("seat-threads-button"));
    expect(fixture.state.lists).toBeGreaterThan(lists);
  });

  it("counts the whole seat, not the page the list has read", async () => {
    const fixture = fake();
    fixture.state.threads = [
      thread({ threadId: "notes", title: "Session notes", lastAt: at(1, 20) }),
      thread({ threadId: "banner", title: "Cache banner", lastAt: at(0, 58), unread: 2 }),
    ];
    fixture.state.total = 57;
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    // The row says its own two; the header says the seat's fifty-seven.
    expect(q("seat-threads-row-unread")?.textContent).toBe("2");
    expect(q("seat-threads-button")?.textContent).toBe("Threads57");
  });

  it("keeps the count it had when a count cannot be read, rather than say nothing is waiting", async () => {
    const fixture = fake();
    fixture.state.threads = [thread({ threadId: "notes", title: "Session notes", lastAt: at(1, 20) })];
    fixture.state.total = 3;
    setSeatThreadsSource(fixture.source);
    await render();
    expect(await act(async () => { await flush(); return q("seat-threads-button")?.textContent; })).toBe("Threads3");

    fixture.state.countFails = true;
    act(() => fixture.change());
    await flush();
    expect(q("seat-threads-button")?.textContent).toBe("Threads3");
  });

  it("marks the thread it shows as read, and the count goes with it", async () => {
    const fixture = fake();
    fixture.state.threads = [thread({ threadId: "notes", title: "Session notes", lastAt: at(1, 20), unread: 2 })];
    setSeatThreadsSource(fixture.source);
    await render();
    expect(q("seat-threads-button")?.textContent).toBe("Threads2");

    await click(q("seat-threads-button"));
    expect(fixture.marks[0]).toEqual({ canvasName: "factory", seatId: "seat-1", threadId: "notes" });
    // Every mark is for the thread on screen; main writes nothing once the point has moved.
    expect(new Set(fixture.marks.map((mark) => mark.threadId))).toEqual(new Set(["notes"]));
    expect(q("seat-threads-row-unread")).toBeNull();
    expect(q("seat-threads-button")?.textContent).toBe("Threads");
  });

  it("reads mail that lands in the thread on screen, so the row never counts what is in front of the operator", async () => {
    const fixture = fake();
    fixture.state.threads = [thread({ threadId: "notes", title: "Session notes", lastAt: at(1, 20) })];
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    expect(fixture.state.threads[0]?.unread).toBe(0);

    // Mail arrives in the thread the popup is showing: the seat reads again, and the row is read at once.
    fixture.state.threads = [{ ...fixture.state.threads[0]!, unread: 1 }];
    act(() => fixture.change());
    await flush();
    expect(fixture.marks.filter((mark) => mark.threadId === "notes").length).toBeGreaterThan(0);
    expect(fixture.state.threads[0]?.unread).toBe(0);
    expect(q("seat-threads-row-unread")).toBeNull();
  });

  it("clears a thread the operator read on the phone", async () => {
    const fixture = fake();
    fixture.state.threads = [
      thread({ threadId: "notes", title: "Session notes", lastAt: at(1, 20) }),
      thread({ threadId: "banner", title: "Cache banner", lastAt: at(0, 58), unread: 4 }),
    ];
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    expect(q("seat-threads-row-unread")?.textContent).toBe("4");

    act(() => fixture.readElsewhere("banner"));
    await flush();
    expect(q("seat-threads-row-unread")).toBeNull();
    expect(q("seat-threads-button")?.textContent).toBe("Threads");
  });

  it("reads a change for another seat as nothing to do", async () => {
    const fixture = fake();
    fixture.state.threads = [thread({ threadId: "banner", title: "Cache banner", unread: 4 })];
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    const reads = fixture.state.lists;
    act(() => fixture.readElsewhere("banner", ["seat-9"]));
    await flush();
    expect(fixture.state.lists).toBe(reads);
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
      messageId: "m1", threadId: "t1", from: operator, to: [ptyLead], mine: true,
      text: "Move them, [@cli-lead](junto://canvas/factory?node=seat-cli).", at: at(1, 2),
    };
    const summary: MailThreadSummary = {
      threadId: "t1", title: "Move them.", participants: [operator, ptyLead], startedAt: at(1, 2), lastAt: at(1, 2),
      last: first, messageCount: 1, canReply: true, owned: true, unread: 0,
    };
    const mail = new Set<(event: { canvasName: string; nodeId: string }) => void>();
    const readChanges = new Set<(change: { canvasName: string; threadId: string; seats: ReadonlyArray<string> }) => void>();
    const seatThreadsList = vi.fn(async () => ({ threads: [summary] }));
    (window as { junto?: unknown }).junto = {
      seatThreadsList,
      seatThreadMessages: vi.fn(async () => ({ messages: [first] })),
      onWorkMailChanged: (listener: (event: { canvasName: string; nodeId: string }) => void) => {
        mail.add(listener);
        return () => mail.delete(listener);
      },
      seatThreadUnread: vi.fn(async () => 0),
      seatThreadMarkRead: vi.fn(async () => ({ through: "m1", at: at(1, 3) })),
      onSeatThreadReadChanged: (listener: (change: { canvasName: string; threadId: string; seats: ReadonlyArray<string> }) => void) => {
        readChanges.add(listener);
        return () => readChanges.delete(listener);
      },
    };
    await render();
    await click(q("seat-threads-button"));
    // Each list is read on its own: the operator's, and the one between seats (0.11.5).
    expect(seatThreadsList).toHaveBeenCalledWith({ canvasName: "factory", nodeId: "seat-1", limit: 50, group: "with-you" });
    expect(seatThreadsList).toHaveBeenCalledWith({ canvasName: "factory", nodeId: "seat-1", limit: 50, group: "between" });
    expect(q("seat-threads-with-you")?.textContent).toContain("You");
    expect(all("seat-threads-message")[0]?.textContent).toContain("You 01:02");
    // The row previews the latest mail without reading the thread: it rides the list page,
    // with the operator named as this surface names them.
    const page = await juntoSeatThreadsSource()!.list({ canvasName: "factory", seatId: "seat-1", group: "with-you" });
    expect(page.threads[0]?.last).toEqual({
      messageId: "m1",
      author: "you",
      mine: true,
      text: "Move them, [@cli-lead](junto://canvas/factory?node=seat-cli).",
      at: at(1, 2),
    });
    expect(chipLabels()).toEqual(["@cli-lead"]);
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
    // A row leads with who wrote last, not with everyone who is in it.
    expect(withYou.textContent).toContain("pty-lead");
    expect(withYou.textContent).toContain("01:12");
  });

  it("opens on the newest thread with you, oldest first, the operator's own on the right", async () => {
    await open();
    const messages = all("seat-threads-message");
    expect(messages.map((message) => message.querySelector(".seat-threads__prose")?.textContent)).toEqual([
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

  it("sits in a workspace focus modal that maximizes and folds its list away", async () => {
    await open();
    const dialog = document.querySelector('[role="dialog"][aria-label="Threads, pty-lead"]');
    expect(dialog?.querySelector('[data-measure="workspace"]')).not.toBeNull();
    const maximize = dialog?.querySelector<HTMLButtonElement>('[aria-label="Maximize"]');
    await click(maximize ?? null);
    expect(dialog?.getAttribute("data-maximized")).toBe("true");
    await click(dialog?.querySelector('[aria-label="Sidebar"]') ?? null);
    expect(dialog?.querySelector(".two-pane")?.getAttribute("data-sidebar")).toBe("collapsed");
    await click(dialog?.querySelector('.two-pane__strip [aria-label="Sidebar"]') ?? null);
    expect(dialog?.querySelector(".two-pane")?.getAttribute("data-sidebar")).toBeNull();
  });

  it("reads a mention as its label in a row, never as the address it is written as", () => {
    expect(previewText("Status with **bold** and `code`, ask [@Bravo](junto://canvas/seat-threads?node=bravo) about it")).toBe(
      "Status with bold and code, ask @Bravo about it",
    );
    expect(previewText("keep snake_case and __init__")).toBe("keep snake_case and __init__");
  });

  it("opens a thread on a named stream that takes the keyboard, under an h2 subject", async () => {
    await open();
    const stream = q("seat-threads-stream")!;
    expect(stream.getAttribute("role")).toBe("group");
    expect(stream.getAttribute("aria-label")).toBe("Messages in Session notes out of ~/.junto: get it done now");
    expect(stream.getAttribute("tabindex")).toBe("0");
    expect(document.querySelector(".seat-threads__chat-title")?.tagName).toBe("H2");
  });

  it("reads a message as its words: the author tag drops, and the stored mail keeps it", async () => {
    const { state, change } = await open();
    const text = "product-lead: the list row leads with the words, not the tag.\n\n- one\n- two";
    state.messages.notes = [{ messageId: "m1", author: "product-lead", mine: false, text, at: at(1, 2) }];
    change();
    await flush();
    const bubble = all("seat-threads-message")[0]!.querySelector(".seat-threads__prose")!;
    expect(bubble.textContent).toContain("The list row leads with the words, not the tag.");
    expect(bubble.textContent).not.toContain("product-lead:");
    // Render only: the mail main holds is unchanged, so unread counts read the same words.
    expect(state.messages.notes[0]?.text).toBe(text);
  });

  it("draws a long id as one token that keeps the whole value", async () => {
    const { state, change } = await open();
    state.messages.notes = [
      {
        messageId: "m1",
        author: "product-attention",
        mine: false,
        text: "Landed: 01M65NSRWSB3PCSBAG7N44SHXN on local main, and `01M65NSRWSB3PCSBAG7N44SHXN` stays code.",
        at: at(1, 2),
      },
    ];
    change();
    await flush();
    const message = all("seat-threads-message")[0]!;
    const tokens = message.querySelectorAll(".seat-threads__id");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.textContent).toBe("01M65NSRWSB3PCSBAG7N44SHXN");
    expect(tokens[0]?.getAttribute("title")).toBeNull();
    expect(message.querySelector("code")?.textContent).toBe("01M65NSRWSB3PCSBAG7N44SHXN");
  });

  it("lists a thread by the words of its first line: the tag and a long id do not lead the row", async () => {
    const { state, change } = await open();
    state.threads = [
      thread({
        threadId: "tagged",
        title: "Review ask, from product-feed: the Needs you feed's filters",
        participants: ["you", "product-feed"],
        lastAt: at(4, 0),
        last: {
          messageId: "tagged-last",
          author: "product-feed",
          mine: false,
          text: "Review ask, from product-feed: the Needs you feed's filters, 01M65NSRWSB3PCSBAG7N44SHXN",
          at: at(4, 0),
        },
      }),
      ...state.threads,
    ];
    change();
    await flush();
    const row = document.querySelector('[data-thread-id="tagged"] .seat-threads__row-preview')!;
    expect(row.textContent).toBe("Review ask, the Needs you feed's filters, 01M65NSRWSB3PCSBAG7N44SHXN");
    // A row is a button whose name is its text: the whole id is in it, and the
    // stylesheet, not the string, is what cuts the eye's copy.
    expect(row.querySelector(".seat-threads__id")?.textContent).toBe("01M65NSRWSB3PCSBAG7N44SHXN");
  });

  it("draws a message's markdown, with its mention links as chips inside it", async () => {
    const { state, change } = await open();
    state.messages.notes = [
      {
        messageId: "m1",
        author: "pty-lead",
        mine: false,
        text: "**V** and *I* land in `junto.db`.\nAsk [@cli-lead](junto://canvas/factory?node=seat-cli) first.\n\n- one\n- two",
        at: at(1, 2),
      },
    ];
    change();
    await flush();
    const bubble = all("seat-threads-message")[0]!.querySelector(".seat-threads__prose")!;
    expect(bubble.querySelector("strong")?.textContent).toBe("V");
    expect(bubble.querySelector("em")?.textContent).toBe("I");
    expect(bubble.querySelector("code")?.textContent).toBe("junto.db");
    expect(bubble.querySelectorAll("li")).toHaveLength(2);
    expect(bubble.textContent).not.toContain("**");
    expect(chipLabels()).toEqual(["@cli-lead"]);
  });

  it("heads a thread with its subject as words, the whole of it on hover, and previews its latest mail", async () => {
    const fixture = fake();
    fixture.state.threads = [thread({ threadId: "notes", title: "Ship **V** with `junto.db` in place, keep __init__" })];
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    const title = document.querySelector(".seat-threads__chat-title");
    expect(title?.textContent).toBe("Ship V with junto.db in place, keep __init__");
    expect(title?.getAttribute("title")).toBe("Ship **V** with `junto.db` in place, keep __init__");
    // The row previews the words of the latest mail, which is not the subject.
    expect(document.querySelector('[data-thread-id="notes"] .seat-threads__row-preview')?.textContent).toBe("notes");
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

describe("files on a message", () => {
  it("draws an image as a thumbnail and anything else as a chip, and a mail of only files has no empty bubble", async () => {
    const fixture = fake();
    const image = { sha256: "d".repeat(64), byteLength: 2048, mediaType: "image/png", displayName: "shot.png" } as never;
    const doc = { sha256: "e".repeat(64), byteLength: 3 * 1024 * 1024, mediaType: "application/pdf", displayName: "plan.pdf" } as never;
    fixture.state.messages.notes = [
      { messageId: "m1", author: "you", mine: true, text: "", at: at(1, 2), attachments: [image, doc] },
    ];
    setSeatThreadsSource(fixture.source);
    await render();
    await click(q("seat-threads-button"));
    const [thumb, chip] = all("seat-threads-attachment");
    expect(thumb?.getAttribute("data-kind")).toBe("image");
    expect(thumb?.querySelector("img")?.getAttribute("src")).toMatch(/^junto-content:\/\/object\/d{64}\?/u);
    expect(chip?.getAttribute("data-kind")).toBe("file");
    expect(chip?.textContent).toContain("plan.pdf");
    expect(chip?.textContent).toContain("application/pdf, 3.0 MB");
    expect(document.querySelector(".seat-threads__message .seat-threads__body, .seat-threads__message .seat-threads__block")).toBeNull();
    // An image the renderer cannot draw falls back to the chip.
    act(() => thumb?.querySelector("img")?.dispatchEvent(new Event("error")));
    expect(all("seat-threads-attachment")[0]?.getAttribute("data-kind")).toBe("file");
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

  describe("with files", () => {
    const stored = (name: string, mediaType: string) => ({ sha256: "c".repeat(64), byteLength: 6, mediaType, displayName: name });
    let release: (() => void) | undefined;
    const putter = (hold = false) =>
      setOperatorContentPutter(async (input) => {
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        const done = input.stage.done;
        return { ok: true, result: { ref: stored(String(done?.displayName), String(done?.mediaType)) } } as never;
      });
    const attach = async (...files: File[]) => {
      const input = q("attach-files-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { configurable: true, value: files });
      act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
      // The file is read by a FileReader, which settles on a later task.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      await flush();
    };
    const sendButton = () => q("thread-composer-send") as HTMLButtonElement;

    beforeEach(() => {
      URL.createObjectURL = () => "blob:preview";
      URL.revokeObjectURL = () => undefined;
    });
    afterEach(() => setOperatorContentPutter(undefined));

    it("sends a mail that is only a file, with the refs main will claim, and empties the tray", async () => {
      putter();
      await open();
      expect(sendButton().disabled).toBe(true);
      await attach(new File(["pixels"], "shot.png", { type: "image/png" }));
      expect(all("attachment-chip")).toHaveLength(1);
      expect(sendButton().disabled).toBe(false);
      await click(sendButton());
      expect(sends).toEqual([
        { canvasName: "factory", nodeId: "seat-1", text: "", inReplyTo: "m2", attachments: [stored("shot.png", "image/png")] },
      ]);
      expect(all("attachment-chip")).toHaveLength(0);
    });

    it("waits for every file to be in before it sends, and keeps the draft", async () => {
      putter(true);
      await open();
      await type("Look at this.");
      await attach(new File(["pixels"], "shot.png", { type: "image/png" }));
      expect(sendButton().disabled).toBe(true);
      expect(q("thread-composer-uploading")).not.toBeNull();
      await key("Enter");
      expect(sends).toEqual([]);
      await act(async () => release?.());
      await flush();
      expect(sendButton().disabled).toBe(false);
      await key("Enter");
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ text: "Look at this.", attachments: [{ displayName: "shot.png" }] });
    });

    it("keeps the files when main refuses the send", async () => {
      putter();
      reply = { ok: false, reason: "invalid", message: "A file was not uploaded, or it was already sent. Attach it again." };
      await open();
      await attach(new File(["x"], "notes.txt", { type: "text/plain" }));
      await click(sendButton());
      expect(q("thread-composer-failure")?.textContent).toContain("Attach it again");
      expect(all("attachment-chip")).toHaveLength(1);
    });
  });

  it("opens the wired seats on @ and puts the chosen one in the draft as a link, never in To", async () => {
    await open();
    await type("Thanks. @c");
    expect(
      [...document.querySelectorAll('[data-testid="mention-option"] .mention-combobox__label')].map((label) => label.textContent),
    ).toEqual(["@cli-lead", "@canvas-lead"]);
    expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Seats connected to pty-lead, and pages in reach");
    await key("ArrowDown");
    await key("Enter");
    expect(field().value).toBe("Thanks. @canvas-lead ");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(sends).toEqual([]);
    await key("Enter");
    // The text carries the mention as its link, and the seat is never in To.
    expect(sends).toEqual([
      {
        canvasName: "factory",
        nodeId: "seat-1",
        text: "Thanks. [@canvas-lead](junto://canvas/factory?node=seat-canvas)",
        inReplyTo: "m2",
      },
    ]);
  });

  it("closes the @ list on Escape and leaves the popup open", async () => {
    await open();
    await type("@c");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await key("Escape");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
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
    state.messages.fresh = [{ messageId: "fresh", author: "you", mine: true, text: "The loader's start phase.", at: at(2, 0) }];
    change();
    await flush();
    expect(document.querySelector('[data-thread-id="fresh"]')?.getAttribute("data-selected")).toBe("true");
    expect(q("thread-composer")?.getAttribute("data-mode")).toBe("reply");
  });

  it("shows a plain @name as words: only a mention link is a reference", async () => {
    const { state, change } = await open();
    state.messages.notes = [
      {
        messageId: "m1",
        author: "you",
        mine: true,
        text: "Thanks. @cli-lead check it, and @pty-lead or @nobody.",
        at: at(1, 2),
      },
    ];
    change();
    await flush();
    expect(all("seat-threads-mention")).toEqual([]);
    expect(all("seat-threads-message")[0]?.querySelector(".seat-threads__prose")?.textContent).toBe(
      "Thanks. @cli-lead check it, and @pty-lead or @nobody.",
    );
    expect(q("seat-threads")?.querySelector(".seat-threads__chat-meta")?.textContent).not.toContain("cli-lead");
  });

  it("shows a mention link in a message as its label, a reference", async () => {
    const { state, change } = await open();
    state.messages.notes = [
      {
        messageId: "m1",
        author: "you",
        mine: true,
        text: "Ask [@cli-lead](junto://canvas/factory?node=seat-cli) first.",
        at: at(1, 2),
      },
    ];
    change();
    await flush();
    expect(chipLabels()).toEqual(["@cli-lead"]);
    expect(all("seat-threads-mention")[0]?.tagName).toBe("BUTTON");
    expect(all("seat-threads-message")[0]?.querySelector(".seat-threads__prose")?.textContent).toBe("Ask @cli-lead, Seat first.");
  });

  it("a comment thread shows its subject: a glyph in the list, a chip in the header that opens it", async () => {
    const { state, change } = await open();
    const task = "01M5ESSJRFWT6RVS5HMWMGJXGD";
    state.threads = [
      thread({
        threadId: "on-task",
        title: "#42 fix tabs",
        lastAt: at(3, 0),
        subject: { kind: "task", nodeId: "board", taskId: task } as unknown as NonNullable<SeatThreadSummary["subject"]>,
      }),
      ...state.threads,
    ];
    change();
    await flush();
    const row = document.querySelector('[data-thread-id="on-task"]')!;
    expect(row.querySelector(".seat-threads__row-subject svg")).not.toBeNull();
    expect(document.querySelector('[data-thread-id="notes"] .seat-threads__row-subject svg')).toBeNull();
    await click(row);
    const subject = q("seat-threads-subject")!;
    expect(subject.querySelector(".resource-chip__number")?.textContent).toBe("#42");
    expect(subject.querySelector(".resource-chip__label")?.textContent).toBe("fix tabs");
    await click(subject);
    expect(workDetailOpen$.get()).toEqual({ nodeId: "board", itemId: task });
    expect(q("seat-threads")).toBeNull();
  });

  it("a task mention is a chip that leaves the threads and opens the task on its board; a gone node is unavailable", async () => {
    const { state, change } = await open();
    const task = "01M5ESSJRFWT6RVS5HMWMGJXGD";
    state.messages.notes = [
      {
        messageId: "m1",
        author: "you",
        mine: true,
        text: `See [#42 fix tabs](junto://canvas/factory?node=board&item=${task}) and [@gone](junto://canvas/factory?node=seat-gone).`,
        at: at(1, 2),
      },
    ];
    change();
    await flush();
    const [taskChip, gone] = all("seat-threads-mention");
    expect(taskChip?.querySelector(".resource-chip__number")?.textContent).toBe("#42");
    expect(chipLabels()).toEqual(["fix tabs", undefined]);
    expect(gone?.tagName).toBe("DEL");
    expect(gone?.textContent).toBe("gone");
    expect(gone?.getAttribute("data-missing")).toBe("true");
    await click(taskChip!);
    expect(workDetailOpen$.get()).toEqual({ nodeId: "board", itemId: task });
    expect(q("seat-threads")).toBeNull();
  });

  it("past main's text bound sends the text as a file, and says so first", async () => {
    const stored = (name: string, mediaType: string) => ({ sha256: "c".repeat(64), byteLength: 6, mediaType, displayName: name });
    const uploads: Array<{ name: string; type: string }> = [];
    setOperatorContentPutter(async (input) => {
      const done = input.stage.done;
      uploads.push({ name: String(done?.displayName), type: String(done?.mediaType) });
      return { ok: true, result: { ref: stored(String(done?.displayName), String(done?.mediaType)) } } as never;
    });
    await open();
    await type("x".repeat(THREAD_TEXT_MAX + 1));
    expect(q("thread-composer-long-text")?.textContent).toBe(
      `Over ${THREAD_TEXT_MAX.toLocaleString("en-US")} characters, so this goes as message.md, attached`,
    );
    await key("Enter");
    // The text is read into its file on a later task.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await flush();
    expect(uploads).toEqual([{ name: "message.md", type: "text/markdown" }]);
    expect(sends).toEqual([
      { canvasName: "factory", nodeId: "seat-1", text: "", inReplyTo: "m2", attachments: [stored("message.md", "text/markdown")] },
    ]);
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
      const messages = this.querySelectorAll('[data-testid="seat-threads-message"]').length;
      return (rows > 0 ? rows : messages > 0 ? messages : this.children.length) * ROW;
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
  /**
   * The page asks a source saw: a cursor, never the head. The head is read again
   * as the button counts and as the popup marks the thread it shows read (0.11.3),
   * so only a cursor says an older page was asked for.
   */
  const pageAsks = (calls: ReadonlyArray<string | undefined>) => calls.filter((after): after is string => after !== undefined);
  /** As main pages them: each list alone, on its own cursor. */
  const pagedSource = (between: ReadonlyArray<SeatThreadSummary> = []) => {
    const calls: Array<string | undefined> = [];
    const asked: Array<{ readonly group: string; readonly after: string }> = [];
    const everything = Array.from({ length: TOTAL }, (_, n) => threadAt(n));
    const source: SeatThreadsSource = {
      list: async ({ group, after }) => {
        const list = group === "with-you" ? everything : between;
        if (group === "with-you") calls.push(after);
        if (after !== undefined) asked.push({ group, after });
        const from = after === undefined ? 0 : list.findIndex((item) => item.threadId === after) + 1;
        const threads = list.slice(from, from + 50);
        const last = threads.at(-1);
        return { threads, ...(from + 50 < list.length && last ? { next: last.threadId } : {}) };
      },
      messages: async () => ({ messages: [] }),
      onChanged: () => () => undefined,
      markRead: async () => undefined,
      unreadTotal: async () => 0,
      onReadChanged: () => () => undefined,
    };
    return { source, calls, asked, everything };
  };

  it("keeps the operator's threads on the first page however much newer mail is between seats, and pages that list after theirs", async () => {
    // Sixty threads between seats, every one newer than any thread with the operator.
    const between = Array.from({ length: 60 }, (_, n) =>
      thread({ threadId: `b${String(n).padStart(3, "0")}`, participants: ["cli-lead", "pty-lead"], canReply: false, lastAt: at(9, 0) - n * 1000 }));
    const { source, asked } = pagedSource(between);
    setSeatThreadsSource(source);
    await render();
    await click(q("seat-threads-button"));
    const group = (testId: string) => [...(q(testId)?.querySelectorAll('[data-testid="seat-threads-row"]') ?? [])];
    // Both lists open on their own first page: fifty of each, the operator's not pushed off.
    expect(group("seat-threads-with-you")).toHaveLength(50);
    expect(group("seat-threads-between-seats")).toHaveLength(50);

    // Scrolling pages the operator's list until it ends, then the one between seats, each on its own cursor.
    const list = document.querySelector<HTMLElement>(".seat-threads__list")!;
    for (let n = 0; n < 4; n += 1) {
      list.scrollTop = list.scrollHeight - VIEW - 100;
      act(() => list.dispatchEvent(new Event("scroll")));
      await flush();
    }
    expect(asked).toEqual([
      { group: "with-you", after: "t049" },
      { group: "with-you", after: "t099" },
      { group: "between", after: "b049" },
    ]);
    expect(group("seat-threads-with-you")).toHaveLength(TOTAL);
    expect(group("seat-threads-between-seats")).toHaveLength(60);
    expect(q("seat-threads-more")).toBeNull();
  });

  it("reads one page of threads on open and the next as the list is scrolled near its end", async () => {
    const { source, calls } = pagedSource();
    setSeatThreadsSource(source);
    await render();
    await click(q("seat-threads-button"));
    expect(all("seat-threads-row")).toHaveLength(50);
    expect(pageAsks(calls)).toEqual([]);

    const list = document.querySelector<HTMLElement>(".seat-threads__list")!;
    // Far from the end: nothing more is asked for.
    list.scrollTop = 0;
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    expect(pageAsks(calls)).toEqual([]);

    // Near the end: the next page, from the last thread read.
    list.scrollTop = list.scrollHeight - VIEW - 100;
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    expect(pageAsks(calls)).toEqual(["t049"]);
    expect(all("seat-threads-row")).toHaveLength(100);
  });

  it("asks for no older page while the list is folded, and fills it once it shows again", async () => {
    // A folded list is hidden and has no height.
    define("clientHeight", function () {
      return this.closest("[hidden]") === null ? VIEW : 0;
    });
    const { source, calls } = pagedSource();
    setSeatThreadsSource(source);
    await render();
    await click(q("seat-threads-button"));
    const list = document.querySelector<HTMLElement>(".seat-threads__list")!;
    list.scrollTop = list.scrollHeight - VIEW - 100;
    await click(document.querySelector('[aria-label="Sidebar"]'));
    act(() => list.dispatchEvent(new Event("scroll")));
    act(() => resized.forEach((fire) => fire()));
    await flush();
    expect(pageAsks(calls)).toEqual([]);

    // Folded, the toggle that shows is the strip's.
    await click(document.querySelector('.two-pane__strip [aria-label="Sidebar"]'));
    act(() => resized.forEach((fire) => fire()));
    await flush();
    expect(pageAsks(calls)).toEqual(["t049"]);
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
      refreshSeatThreads(SEAT);
    });
    await flush();
    const rows = all("seat-threads-row").map((row) => row.getAttribute("data-thread-id"));
    expect(rows).toHaveLength(100);
    expect(rows[0]).toBe(lifted.threadId);
    expect(new Set(rows).size).toBe(rows.length);
    expect(calls.at(-1)).toBeUndefined();
  });

  it("asks once for a page that fails and again only on the reader's next scroll", async () => {
    const { source, calls } = pagedSource();
    const reading = source.list;
    let failing = false;
    setSeatThreadsSource({
      ...source,
      list: async (seat) => {
        if (failing && seat.after !== undefined) {
          calls.push(seat.after);
          throw new Error("no page");
        }
        return reading(seat);
      },
    });
    await render();
    await click(q("seat-threads-button"));
    failing = true;
    const list = document.querySelector<HTMLElement>(".seat-threads__list")!;
    list.scrollTop = list.scrollHeight - VIEW - 100;
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    await flush();
    expect(calls.filter((call) => call === "t049")).toHaveLength(1);
    expect(q("seat-threads")?.textContent).toContain("no page");
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    expect(calls.filter((call) => call === "t049")).toHaveLength(2);
  });

  it("lets go of a thread the head no longer has, and keeps the pages beyond it", async () => {
    const { source, everything } = pagedSource();
    setSeatThreadsSource(source);
    await render();
    await click(q("seat-threads-button"));
    const list = document.querySelector<HTMLElement>(".seat-threads__list")!;
    list.scrollTop = list.scrollHeight - VIEW - 100;
    act(() => list.dispatchEvent(new Event("scroll")));
    await flush();
    const gone = everything.splice(10, 1)[0]!;
    await act(async () => {
      refreshSeatThreads(SEAT);
    });
    await flush();
    const rows = all("seat-threads-row").map((row) => row.getAttribute("data-thread-id"));
    expect(rows).not.toContain(gone.threadId);
    expect(rows).toContain("t099");
  });

  it("opens a long thread on its newest page and reads earlier ones keeping the place", async () => {
    const everything = Array.from({ length: 120 }, (_, n) => ({
      messageId: `m${String(n).padStart(3, "0")}`,
      author: "pty-lead",
      mine: false,
      text: `line ${n}`,
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
      markRead: async () => undefined,
      unreadTotal: async () => 0,
      onReadChanged: () => () => undefined,
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
