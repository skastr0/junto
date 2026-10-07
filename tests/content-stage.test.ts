/**
 * Staging: a seat's file crosses into the content store in pieces, is held
 * by a `stage:` owner, and is claimed by the record it was uploaded for.
 * A temp content root; never the operator's home.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { ContentManifest } from "../src/main/junto/content/manifest";
import { contentStoreRoot } from "../src/main/junto/content/paths";
import { createContentService, type ContentServiceShape } from "../src/main/junto/content/service";
import {
  ContentStageError,
  NotStagedByCaller,
  claimStagedContent,
  contentStagingDir,
  makeContentStager,
  type ContentStager,
} from "../src/main/junto/content/stage";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import {
  CONTENT_STAGE_IDLE_MS,
  CONTENT_STAGE_MAX_OPEN_PER_SEAT,
  CONTENT_STAGE_PIECE_BYTES,
  CONTENT_STAGE_UNCLAIMED_MS,
  ContentStageArgs,
} from "../src/shared/content-stage";
import { Schema } from "effect";

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
const vega = { canvasName: "factory", nodeId: "vega" };

const boot = async (clock?: { now: number }) => {
  home = await mkdtemp(join(tmpdir(), "junto-content-stage-"));
  runtime = ManagedRuntime.make(
    ContentManifest.layer.pipe(Layer.provideMerge(makeStateEngineLive(join(home, "junto.db")))),
  );
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const manifest = await runtime.runPromise(ContentManifest);
  const content = createContentService(sql, manifest, contentStoreRoot(home));
  const stager = makeContentStager(content, clock ? { now: () => clock.now } : {});
  return { content, stager };
};

const b64 = (bytes: Buffer | string): string => Buffer.from(bytes).toString("base64");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const args = (value: unknown): ContentStageArgs => Schema.decodeUnknownSync(ContentStageArgs)(value);

const stage = (stager: ContentStager, seat: typeof atlas, value: unknown) =>
  Effect.runPromise(Effect.result(stager.stage(seat, args(value))));

const ok = async (stager: ContentStager, seat: typeof atlas, value: unknown) => {
  const result = await stage(stager, seat, value);
  if (Result.isFailure(result)) throw result.failure;
  return result.success as { stageId?: string; byteLength?: number; ref?: { sha256: string; byteLength: number; mediaType: string; displayName?: string } };
};

const refused = async (stager: ContentStager, seat: typeof atlas, value: unknown) => {
  const result = await stage(stager, seat, value);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("expected a refusal");
  expect(result.failure).toBeInstanceOf(ContentStageError);
  return result.failure;
};

const stagingFiles = (content: ContentServiceShape): string[] =>
  existsSync(contentStagingDir(content.root)) ? readdirSync(contentStagingDir(content.root)) : [];

const owners = async (content: ContentServiceShape, sha256: string) =>
  (await Effect.runPromise(content.listRefs(sha256))).map((row) => row.owner);

describe("content.stage args", () => {
  const decodes = (value: unknown) =>
    Result.isSuccess(Schema.decodeUnknownResult(ContentStageArgs)(value));

  it("takes a piece, a closing call, or both", () => {
    expect(decodes({ bytesBase64: "aGk=" })).toBe(true);
    expect(decodes({ stageId: `stg_${"a".repeat(32)}`, bytesBase64: "aGk=" })).toBe(true);
    expect(decodes({ bytesBase64: "aGk=", done: { mediaType: "text/plain" } })).toBe(true);
    expect(decodes({ stageId: `stg_${"a".repeat(32)}`, done: { mediaType: "image/png", displayName: "shot.png", expected: { sha256: "a".repeat(64), byteLength: 2 } } })).toBe(true);
  });

  it("refuses a call with nothing in it, a path, and a piece too long for the frame", () => {
    expect(decodes({})).toBe(false);
    expect(decodes({ stageId: `stg_${"a".repeat(32)}` })).toBe(false);
    expect(decodes({ bytesBase64: "aGk=", path: "/Users/someone/file.png" })).toBe(false);
    expect(decodes({ stageId: "../../etc/passwd", bytesBase64: "aGk=" })).toBe(false);
    expect(decodes({ bytesBase64: "aGk=", done: { mediaType: "" } })).toBe(false);
    expect(decodes({ bytesBase64: "A".repeat(Math.ceil(CONTENT_STAGE_PIECE_BYTES / 3) * 4 + 4) })).toBe(false);
  });
});

describe("staging a file", () => {
  it("stores a small file in one call and holds it for the seat that sent it", async () => {
    const { content, stager } = await boot();
    const bytes = Buffer.from("one small note");
    const closed = await ok(stager, atlas, {
      bytesBase64: b64(bytes),
      done: { mediaType: "text/plain", displayName: "note.txt" },
    });
    expect(closed).toEqual({
      ref: { sha256: sha(bytes), byteLength: bytes.length, mediaType: "text/plain", displayName: "note.txt" },
    });
    const held = await owners(content, sha(bytes));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: "other", canvasName: "factory", nodeId: "atlas" });
    expect(held[0]!.recordId).toMatch(/^stage:stg_[a-f0-9]{32}$/u);
    const local = await Effect.runPromise(content.localPath(closed.ref as never));
    expect("kind" in local && readFileSync(local.path)).toEqual(bytes);
    expect(stagingFiles(content)).toEqual([]);
    expect(stager.openCount(atlas)).toBe(0);
  });

  it("joins pieces in the order they arrive, well past one frame", async () => {
    const { content, stager } = await boot();
    const pieces = [randomBytes(CONTENT_STAGE_PIECE_BYTES), randomBytes(CONTENT_STAGE_PIECE_BYTES), randomBytes(CONTENT_STAGE_PIECE_BYTES), randomBytes(1234)];
    const whole = Buffer.concat(pieces);
    expect(whole.length).toBeGreaterThan(8 * 1024 * 1024);

    const first = await ok(stager, atlas, { bytesBase64: b64(pieces[0]!) });
    expect(first).toEqual({ stageId: first.stageId, byteLength: CONTENT_STAGE_PIECE_BYTES });
    expect(stager.openCount(atlas)).toBe(1);
    const second = await ok(stager, atlas, { stageId: first.stageId, bytesBase64: b64(pieces[1]!) });
    expect(second).toEqual({ stageId: first.stageId, byteLength: 2 * CONTENT_STAGE_PIECE_BYTES });
    await ok(stager, atlas, { stageId: first.stageId, bytesBase64: b64(pieces[2]!) });
    const closed = await ok(stager, atlas, {
      stageId: first.stageId,
      bytesBase64: b64(pieces[3]!),
      done: { mediaType: "video/mp4", expected: { sha256: sha(whole), byteLength: whole.length } },
    });
    expect(closed.ref).toMatchObject({ sha256: sha(whole), byteLength: whole.length, mediaType: "video/mp4" });
    expect(stagingFiles(content)).toEqual([]);
  });

  it("closes with no last piece, and stores an empty file", async () => {
    const { stager } = await boot();
    const bytes = Buffer.from("sent before the close");
    const opened = await ok(stager, atlas, { bytesBase64: b64(bytes) });
    const closed = await ok(stager, atlas, { stageId: opened.stageId, done: { mediaType: "text/plain" } });
    expect(closed.ref).toMatchObject({ sha256: sha(bytes), byteLength: bytes.length });
    const empty = await ok(stager, atlas, { done: { mediaType: "text/plain", displayName: "empty.txt" } });
    expect(empty.ref).toMatchObject({ byteLength: 0, sha256: sha(Buffer.alloc(0)) });
  });

  it("answers another seat's stage id as not found, and leaves the upload alone", async () => {
    const { stager } = await boot();
    const opened = await ok(stager, atlas, { bytesBase64: b64("atlas's file") });
    for (const value of [
      { stageId: opened.stageId, bytesBase64: b64("vega appends") },
      { stageId: opened.stageId, done: { mediaType: "text/plain" } },
    ]) {
      expect((await refused(stager, vega, value)).code).toBe("not-found");
    }
    expect((await refused(stager, { canvasName: "other", nodeId: "atlas" }, { stageId: opened.stageId, bytesBase64: b64("x") })).code).toBe("not-found");
    expect((await refused(stager, atlas, { stageId: `stg_${"0".repeat(32)}`, bytesBase64: b64("x") })).code).toBe("not-found");
    const closed = await ok(stager, atlas, { stageId: opened.stageId, done: { mediaType: "text/plain" } });
    expect(closed.ref?.sha256).toBe(sha(Buffer.from("atlas's file")));
  });

  it("fails closed when the bytes are not what the caller said, and keeps nothing", async () => {
    const { content, stager } = await boot();
    const bytes = Buffer.from("the real bytes");
    const error = await refused(stager, atlas, {
      bytesBase64: b64(bytes),
      done: { mediaType: "text/plain", expected: { sha256: sha(Buffer.from("other bytes")), byteLength: bytes.length } },
    });
    expect(error.code).toBe("mismatch");
    expect(await owners(content, sha(bytes))).toEqual([]);
    expect(stagingFiles(content)).toEqual([]);
    expect(stager.openCount(atlas)).toBe(0);
  });

  it("refuses bytes that are not Base64 and a piece over the limit", async () => {
    const { content, stager } = await boot();
    for (const bytesBase64 of ["not base64!", "aGk", "aGk=\n", "a===", "YQ=x"]) {
      expect((await refused(stager, atlas, { bytesBase64 })).code).toBe("invalid");
    }
    expect((await refused(stager, atlas, { bytesBase64: b64(Buffer.alloc(CONTENT_STAGE_PIECE_BYTES + 1)) })).code).toBe("invalid");
    // A refused first piece opens nothing.
    expect(stager.openCount(atlas)).toBe(0);
    expect(stagingFiles(content)).toEqual([]);
    // A refused later piece leaves the upload as it was.
    const opened = await ok(stager, atlas, { bytesBase64: b64("kept") });
    await refused(stager, atlas, { stageId: opened.stageId, bytesBase64: "not base64!" });
    const closed = await ok(stager, atlas, { stageId: opened.stageId, done: { mediaType: "text/plain" } });
    expect(closed.ref?.sha256).toBe(sha(Buffer.from("kept")));
  });

  it("never names a path or repeats content in what it refuses", async () => {
    const { content, stager } = await boot();
    const secret = "TOP-SECRET-CONTENT";
    const opened = await ok(stager, atlas, { bytesBase64: b64(secret) });
    const errors = [
      await refused(stager, vega, { stageId: opened.stageId, bytesBase64: b64(secret) }),
      await refused(stager, atlas, { stageId: opened.stageId, bytesBase64: `${b64(secret)}!` }),
      await refused(stager, atlas, { stageId: opened.stageId, done: { mediaType: "text/plain", expected: { sha256: "0".repeat(64), byteLength: 1 } } }),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain(content.root);
      expect(error.message).not.toContain(home!);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(b64(secret));
      expect(error.message).not.toContain("/");
    }
  });

  it("holds a seat to a thousand open uploads, each seat counted on its own", async () => {
    const { stager } = await boot();
    for (let index = 0; index < CONTENT_STAGE_MAX_OPEN_PER_SEAT; index += 1) {
      await ok(stager, atlas, { bytesBase64: "" });
    }
    expect(stager.openCount(atlas)).toBe(CONTENT_STAGE_MAX_OPEN_PER_SEAT);
    expect((await refused(stager, atlas, { bytesBase64: b64("one more") })).code).toBe("too-many");
    expect((await ok(stager, vega, { bytesBase64: b64("another seat") })).byteLength).toBe(12);
  });
});

describe("nothing left behind", () => {
  it("drops an upload with no piece for an hour, and keeps one that is still moving", async () => {
    const clock = { now: 1_000_000 };
    const { content, stager } = await boot(clock);
    const idle = await ok(stager, atlas, { bytesBase64: b64("abandoned") });
    const moving = await ok(stager, atlas, { bytesBase64: b64("still ") });
    clock.now += CONTENT_STAGE_IDLE_MS - 1;
    await ok(stager, atlas, { stageId: moving.stageId, bytesBase64: b64("going") });
    clock.now += 2;
    await Effect.runPromise(stager.sweep());
    expect(stager.openCount(atlas)).toBe(1);
    expect(stagingFiles(content)).toEqual([`${moving.stageId}.stage`]);
    expect((await refused(stager, atlas, { stageId: idle.stageId, bytesBase64: b64("late") })).code).toBe("not-found");
    const closed = await ok(stager, atlas, { stageId: moving.stageId, done: { mediaType: "text/plain" } });
    expect(closed.ref?.sha256).toBe(sha(Buffer.from("still going")));
  });

  it("drops every open upload when the app starts", async () => {
    const { content, stager } = await boot();
    const opened = await ok(stager, atlas, { bytesBase64: b64("from the last run") });
    expect(stagingFiles(content)).toEqual([`${opened.stageId}.stage`]);
    // A file that is not a stage is not this module's to remove.
    mkdirSync(contentStagingDir(content.root), { recursive: true });
    writeFileSync(join(contentStagingDir(content.root), "README"), "not a stage");

    const restarted = makeContentStager(content);
    expect(stagingFiles(content)).toEqual(["README"]);
    expect((await refused(restarted, atlas, { stageId: opened.stageId, bytesBase64: b64("more") })).code).toBe("not-found");
  });

  it("lets go of a finished upload nobody claimed after an hour, and only then", async () => {
    const clock = { now: Date.now() };
    const { content, stager } = await boot(clock);
    const bytes = Buffer.from("uploaded, never attached");
    await ok(stager, atlas, { bytesBase64: b64(bytes), done: { mediaType: "text/plain" } });

    clock.now += CONTENT_STAGE_UNCLAIMED_MS - 60_000;
    await Effect.runPromise(stager.sweep());
    expect(await owners(content, sha(bytes))).toHaveLength(1);

    clock.now += 2 * 60_000;
    await Effect.runPromise(stager.sweep());
    expect(await owners(content, sha(bytes))).toEqual([]);
    const report = await Effect.runPromise(content.collectGarbage({ dryRun: true, orphanGraceMs: 0 }));
    expect(JSON.stringify(report)).toContain(sha(bytes));
  });

  it("releases only stage owners: a claimed file and another owner's file stay", async () => {
    const clock = { now: Date.now() };
    const { content, stager } = await boot(clock);
    const mine = Buffer.from("claimed by a signal");
    const other = Buffer.from("owned by something else whose id only resembles a stage");
    const staged = await ok(stager, atlas, { bytesBase64: b64(mine), done: { mediaType: "text/plain" } });
    const signal = { kind: "other" as const, canvasName: "factory", nodeId: "atlas", recordId: "signal:s1" };
    await Effect.runPromise(claimStagedContent(content, { ...atlas, ref: staged.ref!, owner: signal }));
    await Effect.runPromise(content.put({
      source: other, mediaType: "text/plain",
      owner: { kind: "other", canvasName: "factory", nodeId: "atlas", recordId: "not-stage:x" },
    }));
    await Effect.runPromise(content.put({
      source: other, mediaType: "text/plain",
      owner: { kind: "artifact", canvasName: "factory", nodeId: "atlas", recordId: "stage:looks-like-one" },
    }));

    clock.now += CONTENT_STAGE_UNCLAIMED_MS + 2 * 60_000;
    await Effect.runPromise(stager.sweep());
    expect(await owners(content, sha(mine))).toEqual([signal]);
    expect(await owners(content, sha(other))).toHaveLength(2);
  });
});

describe("claiming a staged file", () => {
  const signal = (id: string) => ({ kind: "other" as const, canvasName: "factory", nodeId: "atlas", recordId: `signal:${id}` });
  const claim = (content: ContentServiceShape, seat: typeof atlas, ref: { sha256: string; byteLength: number }, id: string) =>
    Effect.runPromise(Effect.result(claimStagedContent(content, { ...seat, ref, owner: signal(id) })));

  it("binds the new owner, releases the stage owner, and answers the reference main recorded", async () => {
    const { content, stager } = await boot();
    const bytes = Buffer.from("a screenshot");
    const staged = await ok(stager, atlas, { bytesBase64: b64(bytes), done: { mediaType: "image/png", displayName: "shot.png" } });
    // The caller's copy of the reference may say anything about type and name.
    const claimed = await claim(content, atlas, { sha256: staged.ref!.sha256, byteLength: staged.ref!.byteLength }, "s1");
    expect(Result.isSuccess(claimed)).toBe(true);
    if (Result.isSuccess(claimed)) {
      expect(claimed.success.owner).toEqual(signal("s1"));
      expect(claimed.success.ref).toEqual({ sha256: sha(bytes), byteLength: bytes.length, mediaType: "image/png", displayName: "shot.png" });
    }
    expect(await owners(content, sha(bytes))).toEqual([signal("s1")]);
  });

  it("refuses a file another seat staged, one never staged, and one already claimed", async () => {
    const { content, stager } = await boot();
    const bytes = Buffer.from("atlas uploaded this");
    const staged = await ok(stager, atlas, { bytesBase64: b64(bytes), done: { mediaType: "text/plain" } });
    const notStaged = async (seat: typeof atlas, ref: { sha256: string; byteLength: number }) => {
      const result = await claim(content, seat, ref, "s9");
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(NotStagedByCaller);
    };
    await notStaged(vega, staged.ref!);
    await notStaged({ canvasName: "other", nodeId: "atlas" }, staged.ref!);
    await notStaged(atlas, { sha256: "f".repeat(64), byteLength: 3 });
    await notStaged(atlas, { sha256: staged.ref!.sha256, byteLength: staged.ref!.byteLength + 1 });
    // Bytes held by a signal, but staged by nobody, cannot be claimed again.
    await Effect.runPromise(content.put({ source: Buffer.from("already a signal's"), mediaType: "text/plain", owner: signal("s0") }));
    await notStaged(atlas, { sha256: sha(Buffer.from("already a signal's")), byteLength: 18 });
    expect(await owners(content, sha(bytes))).toHaveLength(1);

    expect(Result.isSuccess(await claim(content, atlas, staged.ref!, "s1"))).toBe(true);
    await notStaged(atlas, staged.ref!);
    expect(await owners(content, sha(bytes))).toEqual([signal("s1")]);
  });

  it("claims the same bytes staged twice once per upload", async () => {
    const { content, stager } = await boot();
    const bytes = Buffer.from("attached to two signals");
    const first = await ok(stager, atlas, { bytesBase64: b64(bytes), done: { mediaType: "text/plain" } });
    await ok(stager, atlas, { bytesBase64: b64(bytes), done: { mediaType: "text/plain" } });
    expect(await owners(content, sha(bytes))).toHaveLength(2);
    expect(Result.isSuccess(await claim(content, atlas, first.ref!, "s1"))).toBe(true);
    expect(Result.isSuccess(await claim(content, atlas, first.ref!, "s2"))).toBe(true);
    expect(Result.isFailure(await claim(content, atlas, first.ref!, "s3"))).toBe(true);
    expect((await owners(content, sha(bytes))).map((owner) => owner.recordId).sort()).toEqual(["signal:s1", "signal:s2"]);
  });
});
