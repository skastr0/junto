import { describe, expect, it, vi } from "vitest";
import type { WorkMailChanged, WorkMailPage, WorkMailQuery } from "../src/shared/work-mail";
import { createWorkMailStore } from "../src/renderer/lib/work-mail-store";
const page = (id: string, position: number, nextBeforePosition?: number): WorkMailPage => ({
  items: [{ position, message: { messageId: id, role: "user", parts: [{ kind: "text", text: id }] } }],
  ...(nextBeforePosition === undefined ? {} : { nextBeforePosition }),
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
describe("seat mailbox store", () => {
  it("refreshes only the addressed subscribed seat and stops listening on release", async () => {
    let notify!: (event: WorkMailChanged) => void;
    const off = vi.fn();
    const read = vi.fn(async (query: WorkMailQuery) => page(query.nodeId, 10));
    const store = createWorkMailStore(() => ({ workMailPage: read, onWorkMailChanged: (listener) => { notify = listener; return off; } }));
    const releaseA = store.retain("factory", "a");
    const releaseB = store.retain("factory", "b");
    await flush(); read.mockClear();
    notify({ canvasName: "factory", nodeId: "a" }); await flush();
    expect(read.mock.calls.map(([query]) => query.nodeId)).toEqual(["a"]);
    releaseA(); releaseB(); expect(off).toHaveBeenCalledOnce();
  });
  it("pages older mail without duplicates and coalesces events arriving during a read", async () => {
    let notify!: (event: WorkMailChanged) => void;
    let complete!: (value: WorkMailPage) => void;
    const read = vi.fn((query: WorkMailQuery): Promise<WorkMailPage> => query.beforePosition === undefined
      ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(page("older", 2)));
    const store = createWorkMailStore(() => ({ workMailPage: read, onWorkMailChanged: (listener) => { notify = listener; return () => {}; } }));
    const release = store.retain("factory", "a");
    await flush();
    for (let i = 0; i < 20; i++) notify({ canvasName: "factory", nodeId: "a" });
    complete(page("latest", 10, 10)); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    complete(page("latest", 10, 10)); await flush();
    const older = store.loadMore("factory", "a"); await flush(); complete(page("latest", 10, 10)); await older;
    expect(store.state("factory", "a").items.peek().map((item) => item.message.messageId)).toEqual(["latest", "older"]);
    release();
  });
});
