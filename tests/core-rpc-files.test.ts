/**
 * The Files group (src/contract/core/files.ts) answered by its handlers
 * (src/core/ops/files.ts). The service is a stand-in; the router, the
 * handlers, the byte tokens and the push of a change are the real ones.
 * Called through the group's own client over a MessageChannel, so what
 * crosses is what the port carries: the wire is proved for every group in
 * tests/core-link-view-state.test.ts, and the one thing the Files group adds
 * to it is bytes, which the JSON codec sends as base64.
 */
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Layer, Result, Scope } from "effect";
import { RpcServer, type RpcClient, type RpcClientError } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeFilesNodeRef,
  decodeFilesSearch,
  decodeFilesSources,
  decodeFilesWriteBody,
  parseFilePath,
  type FilePath,
} from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";
import { serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { FILES_CHANGED } from "../src/contract/core/channels";
import { CoreLink } from "../src/contract/core/link";
import { FilesCore, FilesRpcs } from "../src/contract/core/files";
import { CorePushes } from "../src/core/push";
import { HostClientsNoWindow } from "../src/core/host-clients";

const stand = vi.hoisted(() => ({
  file: "",
  send: undefined as undefined | ((subscriber: number, event: unknown) => void),
}));

vi.mock("../src/core/files/index-worker-host", () => ({ workerRootIndex: {} }));
vi.mock("../src/core/files/service", () => ({
  makeFilesService: (deps: { readonly send: (subscriber: number, event: unknown) => void }) => {
    stand.send = deps.send;
    return {
      closeSubscriber: () => undefined,
      read: async (_ref: unknown, path: string) =>
        path === "a.txt"
          ? { ok: true, value: { kind: "text", text: "hello", stamp: { mtimeMs: 1, size: 5 } } }
          : { ok: false, error: "not-found" },
      // A node a window opened: its file by a fresh handle. Any other node was never opened.
      bytes: async (node: string) =>
        node === "files-1" ? { ok: true, value: { handle: await open(stand.file, "r"), size: 5 } } : { ok: false, error: "no-node" },
    };
  },
}));

const { FilesHandlers } = await import("../src/core/ops/files");

const ref = { canvas: "factory", node: asNodeId("files-1") };
const path = (raw: string): FilePath => {
  const parsed = parseFilePath(raw);
  if (parsed === undefined) throw new Error(`not a file path: ${raw}`);
  return parsed;
};

/** One end of the channel as a link. */
const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

let dir: string;
let scope: Scope.Closeable;
let ports: Array<MessagePort>;
let pushes: Array<readonly [string, unknown]>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-files-rpc-"));
  stand.file = join(dir, "five.bin");
  await writeFile(stand.file, "hello");
  scope = await Effect.runPromise(Scope.make());
  ports = [];
  pushes = [];
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const port of ports) port.close();
  await rm(dir, { recursive: true, force: true });
});

/** The core's Files server on one end of a channel, and main's client of the group on the other. */
const connected = async (): Promise<RpcClient.FromGroup<typeof FilesRpcs, RpcClientError.RpcClientError>> => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const server = RpcServer.layer(FilesRpcs).pipe(
    Layer.provide(FilesHandlers),
    Layer.provide(HostClientsNoWindow),
    Layer.provide(Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushes.push([channel, payload])) })),
    Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(port2)))),
  );
  await Effect.runPromise(Layer.buildWithScope(server, scope));
  const client = await Effect.runPromise(
    Layer.buildWithScope(FilesCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, linkOf(port1)))), scope),
  );
  return Context.get(client, FilesCore);
};

describe("the Files group", () => {
  it("answers a read and a refusal as data", async () => {
    const files = await connected();
    expect(await Effect.runPromise(files.FilesRead({ ref, path: path("a.txt") }))).toEqual({
      ok: true,
      value: { kind: "text", text: "hello", stamp: { mtimeMs: 1, size: 5 } },
    });
    expect(await Effect.runPromise(files.FilesRead({ ref, path: path("gone.txt") }))).toEqual({ ok: false, error: "not-found" });
  });

  it("streams a file's bytes by token and closes its handle", async () => {
    const files = await connected();
    const opened = await Effect.runPromise(files.FilesBytesOpen({ node: "files-1", path: path("five.bin") }));
    if (!opened.ok) throw new Error("the node was refused");
    expect(opened.value.size).toBe(5);
    const chunk = await Effect.runPromise(files.FilesBytesRead({ token: opened.value.token, offset: 1, length: 3 }));
    if (!chunk.ok) throw new Error("the read was refused");
    expect(Buffer.from(chunk.value).toString()).toBe("ell");
    await Effect.runPromise(files.FilesBytesClose({ token: opened.value.token }));
    // A closed token is not found, and an unknown node was never opened.
    expect(await Effect.runPromise(files.FilesBytesRead({ token: opened.value.token, offset: 0, length: 1 }))).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(await Effect.runPromise(files.FilesBytesOpen({ node: "files-9", path: path("five.bin") }))).toEqual({
      ok: false,
      error: "no-node",
    });
  });

  it("publishes a change for the window that has the node open", async () => {
    await connected();
    const event = { node: asNodeId("files-1"), kind: "reset" } as const;
    stand.send?.(7, event);
    expect(pushes).toEqual([[FILES_CHANGED, { subscriber: 7, event }]]);
  });
});

describe("what main decodes from a window before it asks", () => {
  it("refuses a ref, a search, a write body and a source list that are not what the group takes", () => {
    expect(Result.isSuccess(decodeFilesNodeRef({ canvas: "factory", node: "files-1" }))).toBe(true);
    expect(Result.isFailure(decodeFilesNodeRef({ canvas: "", node: "files-1" }))).toBe(true);
    expect(Result.isFailure(decodeFilesNodeRef({ canvas: "factory", node: "files-1", extra: true }))).toBe(true);
    expect(Result.isFailure(decodeFilesSearch({ query: "x".repeat(1025), seq: 1 }))).toBe(true);
    expect(Result.isFailure(decodeFilesSearch({ query: "x", seq: 1.5 }))).toBe(true);
    expect(Result.isSuccess(decodeFilesWriteBody({ text: "t", base: null }))).toBe(true);
    expect(Result.isFailure(decodeFilesWriteBody({ text: "t", base: { mtimeMs: 1, size: -1 } }))).toBe(true);
    expect(Result.isFailure(decodeFilesSources([]))).toBe(true);
    expect(Result.isFailure(decodeFilesSources(["/a\0b"]))).toBe(true);
    expect(Result.isSuccess(decodeFilesSources(["/Users/someone/a.txt"]))).toBe(true);
  });
});
