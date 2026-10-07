import { expect, it, vi } from "vitest";
import { createWorkItemStore } from "../src/renderer/lib/work-item-store";
import type { WorkSinkChanged } from "../src/shared/work-sinks";
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };

it("shares exact row reads and refreshes only that sink, clearing deleted rows", async () => {
  let changed!: (event: WorkSinkChanged) => void;
  const read = vi.fn(async () => ({ id: "old-task", state: "working" as const, history: [] }));
  const store = createWorkItemStore(() => ({ workItem: read, onWorkSinkChanged: (listener) => { changed = listener; return () => {}; } }));
  const query = { canvasName: "factory", nodeId: "tasks", kind: "task" as const, itemId: "old-task" };
  const release = store.retain(query); const releaseOther = store.retain(query);
  await flush(); expect(read).toHaveBeenCalledTimes(1);
  changed({ canvasName: "factory", nodeId: "other" }); await flush();
  expect(read).toHaveBeenCalledTimes(1);
  read.mockImplementationOnce(async () => undefined as never);
  changed({ canvasName: "factory", nodeId: "tasks" }); await flush();
  expect(read).toHaveBeenCalledTimes(2); expect(store.state(query).item.peek()).toBeUndefined();
  release(); releaseOther();
});
