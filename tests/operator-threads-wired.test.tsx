// @vitest-environment jsdom
/**
 * Threads, wired (OperatorThreads over the store): Most urgent first opens in
 * the urgent order, the count of everything not holding the list a second
 * time without it; and a thread the operator did not pick is never read.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperatorThreadRow, OperatorThreadsSource } from "../src/window/lib/operator-threads";

type PageQuery = Parameters<OperatorThreadsSource["list"]>[0];
type Page = Awaited<ReturnType<OperatorThreadsSource["list"]>>;

const CANVAS = "wired";
const urgency: Record<string, string> = {};
const chats: Array<{ threadId: string; picked: boolean }> = [];

vi.mock("../src/window/lib/use-model", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCanvas: () => ({
    nodes: new Map(["a", "b"].map((id) => [id, { id, kind: "agent", title: `seat ${id}` }])),
    wires: new Map(),
  }),
}));
vi.mock("../src/window/components/SeatRing", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  seatUrgencyOf: (seat: { id: string }) => urgency[seat.id],
}));
vi.mock("../src/window/components/threads/SeatThreads", () => ({
  ThreadChat: ({ thread, picked }: { thread: { threadId: string }; picked?: boolean }) => {
    chats.push({ threadId: thread.threadId, picked: picked ?? true });
    return <div data-testid="chat">{thread.threadId}</div>;
  },
}));
vi.mock("../src/window/components/quick-thread/QuickThread", () => ({ QuickThread: () => null }));

const { SeatUrgency } = await import("../src/shared/wire/urgency");
const { state$ } = await import("../src/window/lib/state");
const { resetOperatorThreads, setOperatorThreadsSource } = await import("../src/window/lib/operator-threads");
const { clearThreadsFilters, threadsView$ } = await import("../src/window/lib/threads-view");
const { OperatorThreads } = await import("../src/window/components/feed/OperatorThreads");

const region = { regionId: "", label: "", path: [] };
const row = (threadId: string, nodeId: string, lastAt: number, unread = 0): OperatorThreadRow => ({
  threadId,
  seat: { nodeId, name: `seat ${nodeId}`, portraitIdentity: nodeId },
  region,
  title: threadId,
  startedAt: lastAt,
  lastAt,
  last: { messageId: threadId, from: { kind: "seat", nodeId, name: `seat ${nodeId}` }, text: threadId, at: lastAt },
  messageCount: 1,
  unread,
});

/** Newest first: a's threads are newer, b's older. */
const ROWS = [row("a1", "a", 400, 1), row("a2", "a", 300, 1), row("b1", "b", 200, 1), row("b2", "b", 100)];

const source = (): OperatorThreadsSource => ({
  list: async (query: PageQuery): Promise<Page> => {
    const seats = query.seats === undefined ? undefined : new Set<string>(query.seats);
    const rows = ROWS.filter((held) => (seats === undefined || seats.has(held.seat.nodeId)) && (query.unread !== true || held.unread > 0));
    return { rows, total: rows.length, unread: rows.filter((held) => held.unread > 0).length, regions: [], seatCounts: [], generation: 1 };
  },
  watch: async () => ({ watchId: "w1" }),
  unwatch: async () => undefined,
  onChanged: () => () => undefined,
});

let root: Root;
let host: HTMLDivElement;
const ids = (): Array<string | undefined> =>
  [...document.body.querySelectorAll<HTMLElement>('[data-testid="operator-threads-row"]')].map((one) => one.dataset.thread);

beforeEach(() => {
  chats.length = 0;
  urgency.a = SeatUrgency.group.working;
  urgency.b = SeatUrgency.group.blocked;
  clearThreadsFilters();
  state$.canvasName.set(CANVAS);
  setOperatorThreadsSource(source());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  resetOperatorThreads();
  threadsView$.order.set("newest");
});

it("opens Most urgent first in the urgent order, the blocked seat's threads on top", async () => {
  threadsView$.order.set("urgency");
  act(() => root.render(<OperatorThreads />));
  await vi.waitFor(() => expect(ids()).toEqual(["b1", "b2", "a1", "a2"]));
  // And it holds: nothing read later puts it back newest first.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(ids()).toEqual(["b1", "b2", "a1", "a2"]);
});

it("opens Unread with every thread unread, and tells the chat the first is not the operator's pick", async () => {
  threadsView$.unread.set(true);
  act(() => root.render(<OperatorThreads />));
  await vi.waitFor(() => expect(ids()).toEqual(["a1", "a2", "b1"]));
  expect(chats.length).toBeGreaterThan(0);
  expect(chats.every((chat) => chat.threadId === "a1" && !chat.picked)).toBe(true);
});
