import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { WorkActorQuery, WorkSinkChanged } from "../src/shared/work-sinks";
import { createWorkActorStore } from "../src/renderer/lib/work-actor-store";
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);

it("rebases both cursor fields after a burst without skipping a repeated task id", async () => {
  let changed!: (event: WorkSinkChanged) => void;
  let head = "2";
  const read = vi.fn(async (query: WorkActorQuery) => ({
    kind: "task" as const,
    items: [{ nodeId: query.beforeNodeId === undefined ? "a" : "b", item: { id: query.beforeId ?? head, state: "submitted" as const, history: [] } }],
    ...(query.beforeId === undefined ? { nextBeforeId: head, nextBeforeNodeId: "a" } : {}),
  }));
  const store = createWorkActorStore(() => ({ workActorPage: read, onWorkSinkChanged: (listener) => { changed = listener; return () => {}; } }));
  const query = { canvasName: "factory", seatId, kind: "task" as const };
  const release = store.retain(query); await flush();
  await store.loadMore(query);
  expect(read.mock.calls[2]?.[0]).toMatchObject({ beforeId: "2", beforeNodeId: "a" });
  head = "9"; changed({ canvasName: "factory", nodeId: "tasks" }); await flush();
  expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ beforeId: "9", beforeNodeId: "a" });
  expect(store.state(query).page.peek().items.map((row) => row.item.id)).toEqual(["9", "9"]);
  changed({ canvasName: "other", nodeId: "tasks" }); await flush();
  expect(read).toHaveBeenCalledTimes(5);
  release();
});
