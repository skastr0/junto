/**
 * Files import copies only paths a real drop carried (0.11 release checklist,
 * section 3; 3776924fc). The preload reports each OS path it saw on a dropped
 * File; the core copies a source only if that window reported it, and each
 * such path once. A renderer call alone cannot name a source. The gate under
 * test is the real one in src/main/core-process/ops/files.ts, driven the way
 * main drives it; the service is a stand-in that records what it was asked to
 * copy.
 */
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/junto/files/index-worker-host", () => ({ workerRootIndex: {} }));
vi.mock("../src/main/junto/files/service", () => ({
  makeFilesService: () => ({
    closeSubscriber: () => undefined,
    import: async (_ref: unknown, _into: unknown, sources: ReadonlyArray<string>) => {
      imported.push(sources);
      return { ok: true, value: [] };
    },
  }),
}));

const imported: Array<ReadonlyArray<string>> = [];
const { coreOpBody } = await import("../src/main/core-process/ops");
await import("../src/main/core-process/ops/files");

const run = <A>(name: string, input: unknown): Promise<A> => {
  const body = coreOpBody(name);
  if (body === undefined) throw new Error(`no core operation named ${name}`);
  return Effect.runPromise(body(input as never) as Effect.Effect<A, never, never>);
};

const REF = { canvas: "factory", node: "files-1" };
const drop = (subscriber: number, path: string) => run<unknown>("files.dropped", { subscriber, path });
const importFrom = (subscriber: number, sources: ReadonlyArray<string>) =>
  run<{ ok: boolean; error?: string }>("files.import", { subscriber, ref: REF, into: "", sources });

beforeEach(async () => {
  imported.length = 0;
  // A window that ends takes its dropped paths with it.
  await run<unknown>("files.windowGone", { subscriber: 1 });
  await run<unknown>("files.windowGone", { subscriber: 2 });
});

describe("files import copies only what a real drop carried", () => {
  it("copies a path this window's drop carried, once", async () => {
    await drop(1, "/Users/someone/Desktop/report.pdf");
    expect(await importFrom(1, ["/Users/someone/Desktop/report.pdf"])).toMatchObject({ ok: true });
    expect(imported).toEqual([["/Users/someone/Desktop/report.pdf"]]);
    // The drop is spent: the same path again is a renderer naming a source.
    expect(await importFrom(1, ["/Users/someone/Desktop/report.pdf"])).toEqual({ ok: false, error: "denied" });
    expect(imported).toHaveLength(1);
  });

  it("refuses a path no drop carried, and copies nothing of a call that names one", async () => {
    expect(await importFrom(1, ["/Users/someone/.ssh/id_ed25519"])).toEqual({ ok: false, error: "denied" });
    await drop(1, "/Users/someone/Desktop/a.txt");
    expect(await importFrom(1, ["/Users/someone/Desktop/a.txt", "/Users/someone/.ssh/id_ed25519"])).toEqual({
      ok: false,
      error: "denied",
    });
    expect(imported).toEqual([]);
  });

  it("refuses another window's drop", async () => {
    await drop(1, "/Users/someone/Desktop/a.txt");
    expect(await importFrom(2, ["/Users/someone/Desktop/a.txt"])).toEqual({ ok: false, error: "denied" });
    expect(imported).toEqual([]);
  });

  it("holds no relative or malformed drop", async () => {
    await drop(1, "relative/a.txt");
    await drop(1, "/a\0b");
    expect(await importFrom(1, ["relative/a.txt"])).toEqual({ ok: false, error: "invalid-path" });
    expect(await importFrom(1, ["/a\0b"])).toEqual({ ok: false, error: "invalid-path" });
    expect(imported).toEqual([]);
  });
});
