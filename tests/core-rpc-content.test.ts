/**
 * The content group (src/contract/core/content.ts) answered by its handlers,
 * called through the group's own client over a real content store, portrait
 * repository and work repository in a temp folder: the operator's upload
 * pieces, an image put and what it refuses, the portrait overrides, and a
 * page box comment's shot purge. What main decodes before it asks is
 * `OperatorContentPut` and the contract's `ContentPutImageInput`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Result, Schema, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentPutImageInput, ContentRpcs } from "../src/contract/core/content";
import { ContentHandlers } from "../src/core/ops/ipc-content";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { PortraitOverrideRepositoryLive } from "../src/core/portraits/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { OperatorContentPut } from "../src/shared/operator-attachments";
import { PortraitSeatId } from "../src/shared/portrait-overrides";

const clientOf = () => RpcTest.makeClient(ContentRpcs);

const machineAt = (root: string) =>
  Layer.mergeAll(
    WorkRepositoryLive,
    PortraitOverrideRepositoryLive,
    makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db")))));

let dir: string;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof machineAt>>, unknown>;
let scope: Scope.Closeable;
let content: Effect.Success<ReturnType<typeof clientOf>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-core-rpc-content-"));
  runtime = ManagedRuntime.make(machineAt(dir));
  scope = await Effect.runPromise(Scope.make());
  const handlers = await runtime.runPromise(Layer.buildWithScope(ContentHandlers, scope));
  content = await runtime.runPromise(clientOf().pipe(Effect.provide(handlers), Effect.provideService(Scope.Scope, scope)));
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

const ask = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const put = (input: typeof ContentPutImageInput.Type) => ask(content.ContentPutImage(input));

describe("the content group", () => {
  it("puts an image into the content store and refuses what is not one, in words", async () => {
    const bytes = Buffer.from("pretend these are an image's bytes");
    const stored = await put({ bytesBase64: bytes.toString("base64"), mediaType: "image/PNG; charset=x", displayName: "  pasted.png  " });
    expect(stored).toMatchObject({ ok: true, ref: { byteLength: bytes.length, mediaType: "image/png", displayName: "pasted.png" } });
    expect(await put({ bytesBase64: "AAAA", mediaType: "text/plain" })).toEqual({
      ok: false,
      error: "unsupported image media type: text/plain",
    });
    expect(await put({ bytesBase64: "***", mediaType: "image/png" })).toEqual({ ok: false, error: "invalid Base64 image payload" });
    expect(await put({ bytesBase64: "AB", mediaType: "image/png" })).toEqual({ ok: false, error: "non-canonical Base64 image payload" });
    expect(await put({ bytesBase64: "", mediaType: "image/png" })).toEqual({ ok: false, error: "invalid Base64 image payload" });
  });

  it("stages an upload as the operator, one piece, and answers the file the store holds", async () => {
    const piece = Schema.decodeUnknownSync(OperatorContentPut)({
      canvasName: "factory",
      stage: { bytesBase64: Buffer.from("plain words").toString("base64"), done: { mediaType: "text/plain", displayName: "notes.txt" } },
    });
    const staged = await ask(content.ContentOperatorPut(piece));
    if (!staged.ok || !("ref" in staged.result)) throw new Error("the upload did not close");
    expect(staged.result.ref).toMatchObject({ byteLength: 11, mediaType: "text/plain", displayName: "notes.txt" });
  });

  it("stores one override per seat, resets it with nothing, and never keeps what is no override", async () => {
    expect(await ask(content.ContentPortraitOverrides())).toEqual({});
    expect(await ask(content.ContentPortraitOverrideSet({ seatId: "seat-a", override: { shape: "toast", eyes: "dot", temperament: 0.5 } }))).toEqual({
      ok: true,
      seatId: "seat-a",
      override: { shape: "toast", eyes: "dot", temperament: 0.5 },
    });
    expect(await ask(content.ContentPortraitOverrides())).toEqual({ "seat-a": { shape: "toast", eyes: "dot", temperament: 0.5 } });
    expect(await ask(content.ContentPortraitOverrideSet({ seatId: "seat-a", override: null }))).toEqual({ ok: true, seatId: "seat-a", override: null });
    expect(await ask(content.ContentPortraitOverrides())).toEqual({});
  });

  it("answers the purge of a comment that holds no screenshot as a refusal in words", async () => {
    const purged = await ask(content.ContentPageShotPurge({ canvasName: "factory", nodeId: "page-1", messageId: "01M5F8P0000000000000000003" }));
    expect(purged.ok).toBe(false);
    if (!purged.ok) expect(purged.message.length).toBeGreaterThan(0);
  });
});

describe("what main decodes before it asks the core", () => {
  it("reads an image put and an operator piece closed, and a seat id by its bound", () => {
    const decode = Schema.decodeUnknownResult(ContentPutImageInput, { onExcessProperty: "error" });
    expect(Result.isSuccess(decode({ bytesBase64: "AAAA", mediaType: "image/png", displayName: undefined }))).toBe(true);
    expect(Result.isFailure(decode({ bytesBase64: "AAAA" }))).toBe(true);
    expect(Result.isFailure(decode({ bytesBase64: "AAAA", mediaType: "image/png", stray: 1 }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(OperatorContentPut, { onExcessProperty: "error" })({ canvasName: "factory" }))).toBe(true);
    expect(Result.isSuccess(Schema.decodeUnknownResult(PortraitSeatId)("8a6b0c1e-1111-4222-a333-444455556666"))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(PortraitSeatId)(" "))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(PortraitSeatId)("x".repeat(1025)))).toBe(true);
  });
});
