/**
 * Files import copies only paths a real drop carried (0.11 release checklist,
 * section 3; 3776924fc). The preload reports each OS path it saw on a dropped
 * File; the core copies a source only if that window reported it, and each
 * such path once. A renderer call alone cannot name a source. The gate under
 * test is the real one in src/core/ops/files.ts, driven through the Files
 * group's client the way main drives it; the service is a stand-in that
 * records what it was asked to copy.
 */
import { Effect, Exit, Layer, Result, Scope } from "effect";
import { RpcTest, type RpcClient } from "effect/rpc";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFilesSources, ROOT_PATH } from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";
import { FilesRpcs } from "../src/contract/core/files";
import { CorePushes } from "../src/core/push";
import { HostClientsNoWindow } from "../src/core/host-clients";

vi.mock("../src/core/files/index-worker-host", () => ({ workerRootIndex: {} }));
vi.mock("../src/core/files/service", () => ({
  makeFilesService: () => ({
    closeSubscriber: () => undefined,
    import: async (_ref: unknown, _into: unknown, sources: ReadonlyArray<string>) => {
      imported.push(sources);
      return { ok: true, value: [] };
    },
  }),
}));

const imported: Array<ReadonlyArray<string>> = [];
const { FilesHandlers } = await import("../src/core/ops/files");

/** One handler Layer for the whole file, so every call meets the dropped paths the calls before it left, as a window's calls meet the core's. */
let scope: Scope.Closeable;
let files: RpcClient.FromGroup<typeof FilesRpcs>;

beforeAll(async () => {
  scope = await Effect.runPromise(Scope.make());
  const handlers = await Effect.runPromise(
    Layer.buildWithScope(FilesHandlers.pipe(Layer.provide([Layer.succeed(CorePushes, { publish: () => Effect.void }), HostClientsNoWindow])), scope),
  );
  files = await Effect.runPromise(
    RpcTest.makeClient(FilesRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const REF = { canvas: "factory", node: asNodeId("files-1") };
const drop = (subscriber: number, path: string) => Effect.runPromise(files.FilesDropped({ subscriber, path }));
const importFrom = (subscriber: number, sources: ReadonlyArray<string>) =>
  Effect.runPromise(files.FilesImport({ subscriber, ref: REF, into: ROOT_PATH, sources }));

beforeEach(async () => {
  imported.length = 0;
  // A window that ends takes its dropped paths with it.
  await Effect.runPromise(files.FilesWindowGone({ subscriber: 1 }));
  await Effect.runPromise(files.FilesWindowGone({ subscriber: 2 }));
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
    // A NUL never reaches the core: main's decoder refuses the source list.
    expect(Result.isFailure(decodeFilesSources(["/a\0b"]))).toBe(true);
    expect(imported).toEqual([]);
  });
});
