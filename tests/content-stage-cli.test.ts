/**
 * `stageFile` and the `content.stage` work op, end to end without a socket:
 * the CLI helper reads a real file from a temp folder and each of its calls
 * goes through the op's handler into a temp content root.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { stageBytes, stageFile } from "../src/cli/core/content-stage";
import { allSchemas, commandCapabilities, renderSchemaContract } from "../src/cli/core/discovery";
import { WireError } from "../src/cli/core/errors";
import { WorkSocket } from "../src/cli/core/socket";
import { ContentManifest } from "../src/main/junto/content/manifest";
import { contentStoreRoot } from "../src/main/junto/content/paths";
import { ContentService, createContentService, type ContentServiceShape } from "../src/main/junto/content/service";
import { claimStagedContent, contentStagingDir } from "../src/main/junto/content/stage";
import { classifyMainAuthoringWorkOperation } from "../src/main/junto/main-authoring-gate";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { requiresConnection } from "../src/main/junto/work/authz";
import { handleContentStage } from "../src/main/junto/work/content-stage";
import { CONTENT_STAGE_PIECE_BYTES } from "../src/shared/content-stage";
import { WORK_MAX_FRAME_BYTES, decodeWorkRequest } from "../src/shared/work-control";

let home: string | undefined;
let runtime:
  | ManagedRuntime.ManagedRuntime<StateEngine | SqlClient.SqlClient | ContentManifest, unknown>
  | undefined;

afterEach(async () => {
  await runtime?.dispose();
  if (home) await rm(home, { recursive: true, force: true });
  runtime = undefined;
  home = undefined;
});

const atlas = { canvasName: "factory", nodeId: "atlas" };
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const boot = async () => {
  home = await mkdtemp(join(tmpdir(), "junto-content-stage-cli-"));
  runtime = ManagedRuntime.make(
    ContentManifest.layer.pipe(Layer.provideMerge(makeStateEngineLive(join(home, "junto.db")))),
  );
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const manifest = await runtime.runPromise(ContentManifest);
  const content = createContentService(sql, manifest, contentStoreRoot(home));
  /** What crossed "the socket": every request, as the frame it would be. */
  const frames: Array<{ readonly bytes: number; readonly args: Record<string, unknown> }> = [];
  const socket = (seat = atlas, tamper?: (args: Record<string, unknown>) => Record<string, unknown>) =>
    Layer.succeed(WorkSocket, WorkSocket.of({
      call: (op, args) => {
        const frame = JSON.stringify({ token: "t", op, args });
        expect(Result.isSuccess(decodeWorkRequest(JSON.parse(frame)))).toBe(true);
        const crossed = JSON.parse(frame).args as Record<string, unknown>;
        frames.push({ bytes: Buffer.byteLength(frame), args: crossed });
        return handleContentStage(seat, tamper ? tamper(crossed) : crossed).pipe(
          Effect.provideService(ContentService, content),
          Effect.mapError((error) => new WireError({ type: error.type, message: error.message })),
        );
      },
    }));
  const file = (name: string, bytes: Buffer): string => {
    const path = join(home!, name);
    writeFileSync(path, bytes);
    return path;
  };
  return { content, frames, socket, file };
};

const stored = async (content: ContentServiceShape, ref: { sha256: string }) => {
  const local = await Effect.runPromise(content.localPath(ref as never));
  if (!("kind" in local)) throw new Error("not stored");
  return readFileSync(local.path);
};

describe("stageFile", () => {
  it("sends a small file in one call, with its digest, and answers the reference", async () => {
    const { content, frames, socket, file } = await boot();
    const bytes = Buffer.from("a small text file\n");
    const ref = await Effect.runPromise(
      stageFile(file("note.txt", bytes), { mediaType: "text/plain", displayName: "note.txt" }).pipe(Effect.provide(socket())),
    );
    expect(ref).toEqual({ sha256: sha(bytes), byteLength: bytes.length, mediaType: "text/plain", displayName: "note.txt" });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args).toEqual({
      bytesBase64: bytes.toString("base64"),
      done: { mediaType: "text/plain", displayName: "note.txt", expected: { sha256: sha(bytes), byteLength: bytes.length } },
    });
    expect(await stored(content, ref)).toEqual(bytes);
  });

  it("sends a file larger than the frame in pieces that each fit, and the path never crosses", async () => {
    const { content, frames, socket, file } = await boot();
    const bytes = randomBytes(2 * CONTENT_STAGE_PIECE_BYTES + 4321);
    expect(bytes.length).toBeGreaterThan(WORK_MAX_FRAME_BYTES);
    const path = file("clip.mp4", bytes);
    const ref = await Effect.runPromise(
      stageFile(path, { mediaType: "video/mp4" }).pipe(Effect.provide(socket())),
    );
    expect(ref).toEqual({ sha256: sha(bytes), byteLength: bytes.length, mediaType: "video/mp4" });
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.bytes).toBeLessThan(WORK_MAX_FRAME_BYTES);
      expect(JSON.stringify(Object.keys(frame.args))).not.toContain("path");
    }
    expect(JSON.stringify(frames.map((frame) => ({ ...frame.args, bytesBase64: undefined })))).not.toContain(home!);
    // First piece opens, the middle one names the stage, the last one closes.
    expect(Object.keys(frames[0]!.args)).toEqual(["bytesBase64"]);
    expect(Object.keys(frames[1]!.args).sort()).toEqual(["bytesBase64", "stageId"]);
    expect(Object.keys(frames[2]!.args).sort()).toEqual(["bytesBase64", "done", "stageId"]);
    expect(frames[1]!.args.stageId).toBe(frames[2]!.args.stageId);
    expect(await stored(content, ref)).toEqual(bytes);
    expect(readdirSync(contentStagingDir(content.root))).toEqual([]);
  }, 60_000);

  it("closes a file that ends exactly on a piece boundary, and an empty one", async () => {
    const { content, frames, socket, file } = await boot();
    const exact = randomBytes(CONTENT_STAGE_PIECE_BYTES);
    const ref = await Effect.runPromise(
      stageFile(file("exact.bin", exact), { mediaType: "application/octet-stream" }).pipe(Effect.provide(socket())),
    );
    expect(ref.byteLength).toBe(CONTENT_STAGE_PIECE_BYTES);
    expect(frames).toHaveLength(1);
    expect(await stored(content, ref)).toEqual(exact);

    const empty = await Effect.runPromise(
      stageFile(file("empty.txt", Buffer.alloc(0)), { mediaType: "text/plain" }).pipe(Effect.provide(socket())),
    );
    expect(empty).toMatchObject({ byteLength: 0, sha256: sha(Buffer.alloc(0)) });
  }, 60_000);

  it("leaves a reference only the sending seat can claim", async () => {
    const { content, socket, file } = await boot();
    const bytes = Buffer.from("for a signal");
    const ref = await Effect.runPromise(
      stageFile(file("for-signal.txt", bytes), { mediaType: "text/plain" }).pipe(Effect.provide(socket())),
    );
    const owner = { kind: "other" as const, canvasName: "factory", nodeId: "atlas", recordId: "signal:s1" };
    const other = await Effect.runPromise(Effect.result(claimStagedContent(content, { canvasName: "factory", nodeId: "vega", ref, owner })));
    expect(Result.isFailure(other)).toBe(true);
    const mine = await Effect.runPromise(claimStagedContent(content, { ...atlas, ref, owner }));
    expect(mine.owner).toEqual(owner);
  });

  it("fails when the bytes change on the way, and keeps nothing", async () => {
    const { content, socket, file } = await boot();
    const bytes = Buffer.from("what the seat sent");
    const tamper = (args: Record<string, unknown>) => ({ ...args, bytesBase64: Buffer.from("what arrived instead").toString("base64") });
    const result = await Effect.runPromise(Effect.result(
      stageFile(file("tampered.txt", bytes), { mediaType: "text/plain" }).pipe(Effect.provide(socket(atlas, tamper))),
    ));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toMatchObject({ _tag: "WireError", type: "InputError" });
    expect(await Effect.runPromise(content.listRefs(sha(Buffer.from("what arrived instead"))))).toEqual([]);
    expect(readdirSync(contentStagingDir(content.root))).toEqual([]);
  });

  it("refuses a file it cannot read before calling main", async () => {
    const { frames, socket } = await boot();
    const result = await Effect.runPromise(Effect.result(
      stageFile(join(home!, "no-such-file.png"), { mediaType: "image/png" }).pipe(Effect.provide(socket())),
    ));
    expect(Result.isFailure(result) && result.failure._tag).toBe("InputError");
    expect(frames).toEqual([]);
  });
});

describe("stageBytes", () => {
  it("sends text held in memory in one call, the way a small file goes", async () => {
    const { content, frames, socket } = await boot();
    const text = "const limit = 10;\n";
    const ref = await Effect.runPromise(
      stageBytes(text, { mediaType: "text/plain", displayName: "snippet.ts" }).pipe(Effect.provide(socket())),
    );
    const bytes = Buffer.from(text);
    expect(ref).toEqual({ sha256: sha(bytes), byteLength: bytes.length, mediaType: "text/plain", displayName: "snippet.ts" });
    expect(frames).toHaveLength(1);
    expect(await stored(content, ref)).toEqual(bytes);
    expect(frames[0]!.args).toEqual({
      bytesBase64: bytes.toString("base64"),
      done: { mediaType: "text/plain", displayName: "snippet.ts", expected: { sha256: sha(bytes), byteLength: bytes.length } },
    });
  });

  it("sends bytes larger than the frame in pieces, and closes on a piece boundary", async () => {
    const { content, frames, socket } = await boot();
    const bytes = randomBytes(2 * CONTENT_STAGE_PIECE_BYTES);
    const ref = await Effect.runPromise(stageBytes(bytes, { mediaType: "application/octet-stream" }).pipe(Effect.provide(socket())));
    expect(ref).toEqual({ sha256: sha(bytes), byteLength: bytes.length, mediaType: "application/octet-stream" });
    for (const frame of frames) expect(frame.bytes).toBeLessThan(WORK_MAX_FRAME_BYTES);
    expect(await stored(content, ref)).toEqual(bytes);
    expect(readdirSync(contentStagingDir(content.root))).toEqual([]);
  }, 60_000);
});

describe("work op content.stage", () => {
  it("is seat-local: no edge, closed with the authorial gate", () => {
    expect(requiresConnection("content.stage")).toBe(false);
    expect(classifyMainAuthoringWorkOperation("content.stage")).toBe("authorial");
  });

  it("refuses malformed args in fixed words that repeat nothing sent", async () => {
    const { content } = await boot();
    const secret = "SECRET-FILE-CONTENT";
    for (const args of [
      {},
      { bytesBase64: 42 },
      { bytesBase64: secret, path: `/Users/someone/${secret}` },
      { stageId: secret, bytesBase64: "aGk=" },
      { bytesBase64: "aGk=", done: { mediaType: "", displayName: secret } },
      secret,
    ]) {
      const result = await Effect.runPromise(Effect.result(
        handleContentStage(atlas, args).pipe(Effect.provideService(ContentService, content)),
      ));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.type).toBe("InputError");
        expect(JSON.stringify(result.failure)).not.toContain(secret);
      }
    }
  });

  it("maps a refusal to its work error, and answers RuntimeDown with no content store", async () => {
    const { content } = await boot();
    const run = (args: unknown) => Effect.runPromise(Effect.result(
      handleContentStage(atlas, args).pipe(Effect.provideService(ContentService, content)),
    ));
    expect(await run({ stageId: `stg_${"0".repeat(32)}`, bytesBase64: "aGk=" }))
      .toMatchObject({ failure: { type: "UnknownTarget", details: { retryable: false } } });
    expect(await run({ bytesBase64: "aGk=", done: { mediaType: "text/plain", expected: { sha256: "0".repeat(64), byteLength: 2 } } }))
      .toMatchObject({ failure: { type: "InputError" } });
    expect(await run({ bytesBase64: "aGk=", done: { mediaType: "text/plain" } }))
      .toMatchObject({ success: { ref: { byteLength: 2, mediaType: "text/plain" } } });
    expect(await Effect.runPromise(Effect.result(handleContentStage(atlas, { bytesBase64: "aGk=" }))))
      .toMatchObject({ failure: { type: "RuntimeDown" } });
  });

  it("is documented by schema show, and is not offered as a command", () => {
    const schema = allSchemas.find((contract) => contract.command_id === "content.stage");
    expect(schema).toBeDefined();
    expect(schema!.description).toContain("--attach");
    expect(Object.keys((renderSchemaContract(schema!).schema as { properties: object }).properties).sort())
      .toEqual(["bytesBase64", "done", "stageId"]);
    expect(commandCapabilities.some((capability) => capability.command_id === "content.stage")).toBe(false);
  });
});
