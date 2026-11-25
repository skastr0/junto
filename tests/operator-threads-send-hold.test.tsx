// @vitest-environment jsdom
/**
 * A reply sent from Global threads is not drawn as waiting on its row inside
 * the first second: the row reads the same hold the thread's own mark does,
 * which the real send (sendSeatThread) puts on the mail it sent. A mail the
 * seat has not taken after the second is drawn as waiting, as before; mail
 * not sent from here (history) is drawn at once.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperatorThreadRow, OperatorThreadsSource } from "../src/window/lib/operator-threads";

const CANVAS = "send-hold";
let waitingRows = new Set<string>();
// When each row's last mail was written; the default is long ago.
let writtenAt: Record<string, number> = {};
let gate: Promise<void> | undefined;

vi.mock("../src/window/lib/use-model", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCanvas: () => ({ nodes: new Map([["a", { id: "a", kind: "agent", title: "seat a" }]]), wires: new Map() }),
}));
vi.mock("../src/window/components/threads/SeatThreads", () => ({ ThreadChat: () => null }));
vi.mock("../src/window/components/quick-thread/QuickThread", () => ({ QuickThread: () => null }));

const { state$ } = await import("../src/window/lib/state");
const { resetOperatorThreads, setOperatorThreadsSource } = await import("../src/window/lib/operator-threads");
const { clearThreadsFilters, threadsView$ } = await import("../src/window/lib/threads-view");
const { resetSeatThreads, sendSeatThread } = await import("../src/window/lib/seat-threads");
const { OperatorThreads } = await import("../src/window/components/feed/OperatorThreads");

const region = { regionId: "", label: "", path: [] };
const row = (threadId: string, messageId: string, waiting: boolean): OperatorThreadRow => ({
  threadId,
  seat: { nodeId: "a", name: "seat a", portraitIdentity: "a" },
  region,
  title: threadId,
  startedAt: 100,
  lastAt: 100,
  last: { messageId, from: { kind: "operator" }, text: "Are you there?", at: writtenAt[messageId] ?? 100, ...(waiting ? { waiting: true as const } : {}) },
  messageCount: 1,
  unread: 0,
});

const source = (): OperatorThreadsSource => ({
  list: async () => {
    const rows = [row("t-sent", "m-sent", waitingRows.has("m-sent")), row("t-old", "m-old", waitingRows.has("m-old"))];
    return { rows, total: rows.length, unread: 0, regions: [], seatCounts: [], generation: 1 };
  },
  watch: async () => ({ watchId: "w1" }),
  unwatch: async () => undefined,
  onChanged: () => () => undefined,
});

let root: Root;
let host: HTMLDivElement;
const marked = (): Array<string | undefined> =>
  [...document.body.querySelectorAll<HTMLElement>('[data-testid="operator-threads-row"]')]
    .filter((one) => one.querySelector('[data-testid="operator-threads-row-waiting"]') !== null)
    .map((one) => one.dataset.thread);

beforeEach(() => {
  waitingRows = new Set(["m-sent", "m-old"]);
  writtenAt = {};
  gate = undefined;
  clearThreadsFilters();
  state$.canvasName.set(CANVAS);
  (window as { junto?: unknown }).junto = {
    seatThreadSend: async () => {
      await gate;
      return { ok: true, messageId: "m-sent", threadId: "t-sent", delivery: "waiting_for_seat" };
    },
  };
  setOperatorThreadsSource(source());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete (window as { junto?: unknown }).junto;
  resetOperatorThreads();
  resetSeatThreads();
  threadsView$.order.set("newest");
});

const rowsShown = async (): Promise<void> => {
  act(() => root.render(<OperatorThreads />));
  await vi.waitFor(() => expect(document.body.querySelectorAll('[data-testid="operator-threads-row"]').length).toBe(2));
};

it("draws no waiting on the row of a reply just sent from here, until its second is up", async () => {
  await rowsShown();
  // History is drawn as it is: the old mail waits, and says so at once.
  expect(marked()).toContain("t-old");
  vi.useFakeTimers();
  await act(async () => {
    await sendSeatThread({ canvasName: CANVAS, seatId: "a", text: "Are you there?", threadId: "t-sent" });
  });
  // The read already says it waits; the row does not draw it inside the second.
  expect(marked()).toEqual(["t-old"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(900);
  });
  expect(marked()).toEqual(["t-old"]);
  // Still unarrived at the second: drawn.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(marked().sort()).toEqual(["t-old", "t-sent"]);
});

it("never draws it for a reply its seat takes inside the second", async () => {
  await rowsShown();
  vi.useFakeTimers();
  await act(async () => {
    await sendSeatThread({ canvasName: CANVAS, seatId: "a", text: "Are you there?", threadId: "t-sent" });
  });
  waitingRows.delete("m-sent");
  setOperatorThreadsSource(source());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(marked()).not.toContain("t-sent");
});

it("draws nothing for mail the list shows before the send's own answer names it", async () => {
  // The write can reach the list as a pushed change before the send's answer does.
  waitingRows = new Set(["m-old"]);
  await rowsShown();
  expect(marked()).toEqual(["t-old"]);
  vi.useFakeTimers();
  let letThrough!: () => void;
  gate = new Promise<void>((resolve) => (letThrough = resolve));
  const sending = sendSeatThread({ canvasName: CANVAS, seatId: "a", text: "Are you there?", threadId: "t-sent" });
  // The list now has the mail, waiting, written just now, and the answer has not come.
  waitingRows.add("m-sent");
  writtenAt["m-sent"] = Date.now();
  setOperatorThreadsSource(source());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(marked()).toEqual(["t-old"]);
  // The answer comes: the hold by id takes over, and the second runs from there.
  letThrough();
  await act(async () => {
    await sending;
    await vi.advanceTimersByTimeAsync(900);
  });
  expect(marked()).toEqual(["t-old"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(marked().sort()).toEqual(["t-old", "t-sent"]);
});
