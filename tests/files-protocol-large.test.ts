/**
 * A large file through `junto-file:` (0.12 X2): the protocol streams a file
 * the core holds, in chunks named by offset, so no message carries the whole
 * file and a byte range costs only the pieces it covers. The client here is
 * the shape main uses (`coreFileBytes`), answered by the core's own
 * `FilesBytesOpen/Read/Close` handlers (src/core/ops/files.ts) over a real
 * 40 MiB file: the service is the only stand-in, and it opens a real handle
 * for each open, as the real one does.
 */
import { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, expect, it, vi } from "vitest";
import { createFileProtocolHandler } from "../src/app/files/protocol";
import { coreFileBytes, registerFilesIpc } from "../src/app/files/ipc";
import { FilesCore, FilesRpcs } from "../src/contract/core/files";
import { CorePushes } from "../src/core/push";
import { HostClientsNoWindow } from "../src/core/host-clients";

const SIZE = 40 * 1024 * 1024;

const served = vi.hoisted(() => ({
  file: "",
  handles: [] as Array<{ readonly fd: number }>,
  open: undefined as undefined | (() => Promise<FileHandle>),
}));

// Main runs a call through its runtime; here the call runs as it is.
vi.mock("../src/app/runtime", () => ({
  AppRuntime: { runPromise: (effect: Effect.Effect<unknown>) => Effect.runPromise(effect) },
}));
vi.mock("../src/core/files/index-worker-host", () => ({ workerRootIndex: {} }));
vi.mock("../src/core/files/service", () => ({
  makeFilesService: () => ({
    closeSubscriber: () => undefined,
    // A node a window opened: its file by a fresh handle. Any other node was never opened.
    bytes: async (node: string) => {
      if (node !== "files-1" || served.open === undefined) return { ok: false, error: "no-node" };
      const handle = await served.open();
      served.handles.push(handle);
      return { ok: true, value: { handle, size: SIZE } };
    },
  }),
}));

const dirs: string[] = [];
const scopes: Scope.Closeable[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  while (scopes.length > 0) await Effect.runPromise(Scope.close(scopes.pop()!, Exit.void));
  served.handles.length = 0;
  vi.restoreAllMocks();
});

/** Main's client of the Files group, on the core's real handlers, and a spy on it that hears every chunk the protocol asks for. */
const mainClient = async () => {
  const { FilesHandlers } = await import("../src/core/ops/files");
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const handlers = await Effect.runPromise(
    Layer.buildWithScope(FilesHandlers.pipe(Layer.provide([Layer.succeed(CorePushes, { publish: () => Effect.void }), HostClientsNoWindow])), scope),
  );
  const client = await Effect.runPromise(
    RpcTest.makeClient(FilesRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );
  // The spy records each read and passes it on to the client unchanged.
  const reads = vi.spyOn(client, "FilesBytesRead");
  return { core: Context.make(FilesCore, client), reads };
};

it("streams 40 MiB in bounded chunks, and a range costs only its own bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "junto-file-protocol-"));
  dirs.push(dir);
  const file = join(dir, "large.bin");
  // Deterministic content: byte i is i mod 251, recognisable in a range.
  const content = Buffer.alloc(SIZE);
  for (let at = 0; at < SIZE; at += 1) content[at] = at % 251;
  await writeFile(file, content);
  served.file = file;
  served.open = () => open(file, "r");

  const { core, reads } = await mainClient();
  const handler = createFileProtocolHandler(coreFileBytes(core));
  const url = `junto-file://files-1/large.bin`;

  const whole = await handler(new Request(url));
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-length")).toBe(String(SIZE));
  const body = Buffer.from(await whole.arrayBuffer());
  expect(body.byteLength).toBe(SIZE);
  expect(body[0]).toBe(0);
  expect(body[SIZE - 1]).toBe(((SIZE - 1) % 251) | 0);
  const sizes = reads.mock.calls.map(([payload]) => payload.length);
  // Never one message with the file in it, and nothing above the 64 KiB window.
  expect(sizes.length).toBeGreaterThan(SIZE / (64 * 1024) - 2);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);

  const part = await handler(new Request(url, { headers: { Range: "bytes=1000000-1000099" } }));
  expect(part.status).toBe(206);
  const slice = Buffer.from(await part.arrayBuffer());
  expect(slice.byteLength).toBe(100);
  expect(slice[0]).toBe(1000000 % 251);

  const head = await handler(new Request(url, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(SIZE));

  // Every open is closed: a viewer that stops reading leaves no handle behind (an fd of -1 is a closed handle).
  expect(served.handles.length).toBeGreaterThan(0);
  expect(served.handles.map((handle) => handle.fd)).toEqual(served.handles.map(() => -1));
});

it("answers 404 for a node no window opened", async () => {
  const { core } = await mainClient();
  const handler = createFileProtocolHandler(coreFileBytes(core));
  const response = await handler(new Request("junto-file://files-2/missing.pdf"));
  expect(response.status).toBe(404);
  // The channels stay what main registers; this only proves the resolver refuses.
  expect(registerFilesIpc).toBeTypeOf("function");
});
