/**
 * The window's Global threads store (src/window/lib/operator-threads.ts) over
 * a fake source: the head page, the seats put first, a change laid only when
 * it is newer than what is held, a change during the head read laid after it,
 * a row past the far end left for its page, and a watch let go with the view.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { OperatorThreadRow, OperatorThreadsChanged, OperatorThreadsPage, OperatorThreadsPageQuery } from "../src/shared/operator-threads";
import {
  loadMoreOperatorThreads,
  operatorThreads$,
  resetOperatorThreads,
  retainOperatorThreads,
  setOperatorThreadsSource,
  type OperatorThreadsView,
} from "../src/window/lib/operator-threads";

const region = { regionId: "", label: "", path: [] };
const row = (threadId: string, nodeId: string, lastAt: number): OperatorThreadRow => ({
  threadId,
  seat: { nodeId, name: nodeId, portraitIdentity: nodeId },
  region,
  title: threadId,
  startedAt: lastAt,
  lastAt,
  last: { messageId: threadId, from: { kind: "operator" }, text: threadId, at: lastAt },
  messageCount: 1,
  unread: 0,
});

/** Threads t00..t09, t00 the newest, alternating seats a and b. */
const ROWS = Array.from({ length: 10 }, (_, n) => row(`t${String(n).padStart(2, "0")}`, n % 2 === 0 ? "a" : "b", 1_000 - n * 10));

const fakeSource = (options: { rows?: OperatorThreadRow[]; pageSize?: number; generation?: number; hold?: boolean } = {}) => {
  const rows = options.rows ?? ROWS;
  const listeners = new Set<(change: OperatorThreadsChanged) => void>();
  const lists: OperatorThreadsPageQuery[] = [];
  const unwatched: string[] = [];
  let release: (() => void) | undefined;
  const gate = options.hold === true ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const pageOf = (query: OperatorThreadsPageQuery): OperatorThreadsPage => {
    const seats = query.seats === undefined ? undefined : new Set<string>(query.seats);
    const matched = rows.filter((held) => seats === undefined || seats.has(held.seat.nodeId));
    const start = query.after === undefined ? 0 : matched.findIndex((held) => held.threadId === query.after) + 1;
    const size = Math.min(query.limit ?? 50, options.pageSize ?? 50);
    const page = matched.slice(start, start + size);
    const end = start + size >= matched.length;
    return {
      rows: page,
      ...(end ? {} : { next: page[page.length - 1]!.threadId }),
      total: matched.length,
      unread: 0,
      regions: [],
      seatCounts: [],
      generation: options.generation ?? 1,
    };
  };
  return {
    lists,
    unwatched,
    release: () => release?.(),
    push: (change: Omit<OperatorThreadsChanged, "watchId" | "canvasName" | "regions" | "seatCounts" | "unread"> & { watchId?: string }) => {
      for (const listener of listeners)
        listener({ watchId: "w1", canvasName: "c", regions: [], seatCounts: [], unread: 0, ...change });
    },
    source: {
      list: async (query: OperatorThreadsPageQuery) => {
        lists.push(query);
        await gate;
        return pageOf(query);
      },
      watch: async () => ({ watchId: "w1" }),
      unwatch: async (watchId: string) => void unwatched.push(watchId),
      onChanged: (listener: (change: OperatorThreadsChanged) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
};

const VIEW: OperatorThreadsView = { canvasName: "c" };
const stateOf = () => Object.values(operatorThreads$.lists.get()).find((held) => held !== undefined);
const ids = () => stateOf()?.rows.map((held) => held.threadId) ?? [];
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => resetOperatorThreads());

describe("the window's Global threads", () => {
  it("reads the head page, newest first, and pages on to the end", async () => {
    const fake = fakeSource({ pageSize: 4 });
    setOperatorThreadsSource(fake.source);
    const release = retainOperatorThreads(VIEW);
    await expect.poll(() => stateOf()?.loaded).toBe(true);
    expect(ids()).toEqual(["t00", "t01", "t02", "t03"]);
    expect(stateOf()).toMatchObject({ total: 10, hasMore: true });
    await loadMoreOperatorThreads(VIEW);
    await loadMoreOperatorThreads(VIEW);
    expect(ids()).toEqual(ROWS.map((held) => held.threadId));
    expect(stateOf()?.hasMore).toBe(false);
    release();
    expect(stateOf()).toBeUndefined();
    expect(fake.unwatched).toEqual(["w1"]);
  });

  it("puts the urgent seats' threads first, read whole, then the rest by activity", async () => {
    const fake = fakeSource({ pageSize: 4 });
    setOperatorThreadsSource(fake.source);
    const release = retainOperatorThreads({ ...VIEW, urgentFirst: ["b"] });
    await expect.poll(() => stateOf()?.loaded).toBe(true);
    // Every thread of b, past the first page too, then a's of the first page.
    expect(ids()).toEqual(["t01", "t03", "t05", "t07", "t09", "t00", "t02"]);
    expect(fake.lists.some((query) => query.seats?.join() === "b")).toBe(true);
    release();
  });

  it("lays a change newer than the page, and never an older one", async () => {
    const fake = fakeSource({ generation: 5 });
    setOperatorThreadsSource(fake.source);
    const release = retainOperatorThreads(VIEW);
    await expect.poll(() => stateOf()?.loaded).toBe(true);
    fake.push({ rows: [row("t09", "b", 2_000)], gone: ["t00"], total: 9, generation: 4 });
    // Older than the page: the page stands.
    expect(ids()[0]).toBe("t00");
    fake.push({ rows: [row("t09", "b", 2_000)], gone: ["t00"], total: 9, generation: 6 });
    expect(ids()[0]).toBe("t09");
    expect(ids()).not.toContain("t00");
    expect(stateOf()?.total).toBe(9);
    // Another watch's change is not this list's.
    fake.push({ watchId: "w2", rows: [row("zz", "a", 3_000)], gone: [], total: 10, generation: 7 });
    expect(ids()).not.toContain("zz");
    release();
  });

  it("holds a change that lands during the head read and lays it after", async () => {
    const fake = fakeSource({ hold: true, generation: 1 });
    setOperatorThreadsSource(fake.source);
    const release = retainOperatorThreads(VIEW);
    await expect.poll(() => fake.lists.length).toBe(1);
    fake.push({ rows: [row("new", "a", 5_000)], gone: [], total: 11, generation: 2 });
    expect(stateOf()?.loaded ?? false).toBe(false);
    fake.release();
    await expect.poll(() => stateOf()?.loaded).toBe(true);
    expect(ids()[0]).toBe("new");
    expect(stateOf()?.total).toBe(11);
    release();
  });

  it("leaves a row past the far end of a list that goes on for its page", async () => {
    const fake = fakeSource({ pageSize: 4 });
    setOperatorThreadsSource(fake.source);
    const release = retainOperatorThreads(VIEW);
    await expect.poll(() => stateOf()?.loaded).toBe(true);
    // Older than t03, the far end held: not shown until its page is read.
    fake.push({ rows: [row("old", "a", 1)], gone: [], total: 11, generation: 2 });
    await settled();
    expect(ids()).toEqual(["t00", "t01", "t02", "t03"]);
    release();
  });
});
