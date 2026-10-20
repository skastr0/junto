/**
 * The operator's files on a mail, main's side: the desktop stages them as
 * the operator, a mail claims them (typed by their bytes, named as
 * uploaded), and delivery copies each into the work home under the seat and
 * the mail, so the delivered mail lists a path the seat can read. Real
 * content store and manifest in a temp home; no socket.
 */
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPERATOR_ATTACHMENT_MAX_BYTES,
  attachmentMailLines,
  attachmentSizeLabel,
  isThumbnailType,
} from "../src/shared/operator-attachments";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { ContentManifest } from "../src/main/junto/content/manifest";
import {
  claimOperatorAttachments,
  operatorAttachmentLines,
  operatorMailOwner,
  operatorUploadsCounted,
  putOperatorContent,
} from "../src/main/junto/content/operator-attachments";
import { contentStoreRoot } from "../src/main/junto/content/paths";
import { ContentService, createContentService } from "../src/main/junto/content/service";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { handleContentStage } from "../src/main/junto/work/content-stage";
import { WORK_HOME_ENV } from "../src/shared/work-control";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

let home: string | undefined;
let runtime:
  | ManagedRuntime.ManagedRuntime<StateEngine | SqlClient.SqlClient | ContentManifest, unknown>
  | undefined;
const priorWorkHome = process.env[WORK_HOME_ENV];

afterEach(async () => {
  await runtime?.dispose();
  if (home) await rm(home, { recursive: true, force: true });
  runtime = undefined;
  home = undefined;
  if (priorWorkHome === undefined) delete process.env[WORK_HOME_ENV];
  else process.env[WORK_HOME_ENV] = priorWorkHome;
});

const boot = async () => {
  home = await mkdtemp(join(tmpdir(), "junto-operator-attachments-"));
  process.env[WORK_HOME_ENV] = join(home, "work");
  runtime = ManagedRuntime.make(
    ContentManifest.layer.pipe(Layer.provideMerge(makeStateEngineLive(join(home, "junto.db")))),
  );
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const manifest = await runtime.runPromise(ContentManifest);
  const content = createContentService(sql, manifest, contentStoreRoot(home));
  /** The desktop uploads one file as the operator, in one piece. */
  const put = async (name: string, bytes: Buffer, mediaType = "application/octet-stream") => {
    const answer = await Effect.runPromise(
      putOperatorContent("factory", {
        bytesBase64: bytes.toString("base64"),
        done: { mediaType, displayName: name },
      } as never).pipe(Effect.provideService(ContentService, content)),
    );
    if (!answer.ok || !("ref" in answer.result)) throw new Error(answer.ok ? "the upload did not close" : answer.message);
    return answer.result.ref;
  };
  const owner = operatorMailOwner("factory", "atlas", "m1");
  const claim = (refs: ReadonlyArray<Pick<ContentRef, "sha256" | "byteLength">>) =>
    Effect.runPromise(Effect.result(claimOperatorAttachments(content, "factory", refs, owner)));
  const owners = async (bytes: Buffer) =>
    (await Effect.runPromise(content.listRefs(sha(bytes)))).map((row) => row.owner.recordId);
  return { content, put, claim, owners };
};

describe("operator attachments, main", () => {
  it("claims what the operator staged, typed by its bytes, held by the mail", async () => {
    const { put, claim, owners } = await boot();
    const notes = Buffer.from("# plan");
    const result = await claim([await put("shot.png", PNG, "text/plain"), await put("plan.md", notes)]);
    expect(Result.isSuccess(result) && result.success).toEqual([
      { sha256: sha(PNG), byteLength: PNG.length, mediaType: "image/png", displayName: "shot.png" },
      { sha256: sha(notes), byteLength: notes.length, mediaType: "text/markdown", displayName: "plan.md" },
    ]);
    expect(await owners(PNG)).toEqual(["m1"]);
  });

  it("refuses a file the operator did not stage, and keeps nothing it took", async () => {
    const { content, put, claim, owners } = await boot();
    const seatFile = Buffer.from("seat bytes");
    // A seat's own upload is not the operator's to send.
    const staged = await Effect.runPromise(
      handleContentStage({ canvasName: "factory", nodeId: "atlas" }, {
        bytesBase64: seatFile.toString("base64"),
        done: { mediaType: "text/plain", displayName: "seat.txt" },
      }).pipe(Effect.provideService(ContentService, content)),
    );
    if (!("ref" in staged)) throw new Error("the upload did not close");
    const result = await claim([await put("shot.png", PNG), staged.ref]);
    expect(Result.isFailure(result) && result.failure.message).toMatch(/not uploaded/);
    expect(await owners(PNG)).not.toContain("m1");
  });

  it("refuses more than ten files", async () => {
    const { claim } = await boot();
    const refs = Array.from({ length: 11 }, (_, index) => ({ sha256: "a".repeat(63) + String(index % 10), byteLength: 1 }) as ContentRef);
    const result = await claim(refs);
    expect(Result.isFailure(result) && result.failure.message).toBe("A mail carries at most 10 files.");
  });

  it("delivers each file to a path under the work home that holds its bytes", async () => {
    const { content, put, claim } = await boot();
    const claimed = await claim([await put("shot.png", PNG)]);
    if (!Result.isSuccess(claimed)) throw new Error("claim failed");
    const lines = await Effect.runPromise(
      operatorAttachmentLines(content, { canvasName: "factory", nodeId: "atlas", messageId: "m1", refs: claimed.success }),
    );
    expect(lines).toHaveLength(1);
    const match = /^Attached: shot\.png \(image\/png, 70 bytes\): (.+)$/.exec(lines[0]!);
    expect(match).not.toBeNull();
    const path = match![1]!;
    expect(isAbsolute(path)).toBe(true);
    expect(path.startsWith(join(home!, "work"))).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(await readFile(path)).toEqual(PNG);
  });
});

describe("operator attachments, the size limit", () => {
  it("refuses the piece that crosses 25 MB before it is written, and the upload goes no further", async () => {
    const { content } = await boot();
    const run = (args: Record<string, unknown>) =>
      Effect.runPromise(putOperatorContent("factory", args as never).pipe(Effect.provideService(ContentService, content)));
    const piece = Buffer.alloc(4 * 1024 * 1024, 1).toString("base64");
    const first = await run({ bytesBase64: piece });
    if (!first.ok || "ref" in first.result) throw new Error("the upload did not open");
    const stageId = first.result.stageId;
    // 24 MB in: one more 4 MB piece would cross 25 MB.
    for (let i = 0; i < 5; i += 1) expect((await run({ stageId, bytesBase64: piece })).ok).toBe(true);
    const counted = operatorUploadsCounted();
    expect(await run({ stageId, bytesBase64: piece })).toEqual({ ok: false, message: "A file is at most 25 MB." });
    // The refused upload is forgotten and dropped: it cannot go on with a smaller piece.
    expect(operatorUploadsCounted()).toBe(counted - 1);
    expect(await run({ stageId, bytesBase64: Buffer.from("x").toString("base64") })).toEqual({
      ok: false,
      message: "no such upload is open for this seat; it may have expired, start the file over",
    });
    expect(operatorUploadsCounted()).toBe(counted - 1);
  });

  it("takes a file of exactly 25 MB", async () => {
    const { content } = await boot();
    const run = (args: Record<string, unknown>) =>
      Effect.runPromise(putOperatorContent("factory", args as never).pipe(Effect.provideService(ContentService, content)));
    const piece = Buffer.alloc(4 * 1024 * 1024, 2).toString("base64");
    const first = await run({ bytesBase64: piece });
    if (!first.ok || "ref" in first.result) throw new Error("the upload did not open");
    const stageId = first.result.stageId;
    for (let i = 0; i < 5; i += 1) await run({ stageId, bytesBase64: piece });
    const last = await run({
      stageId,
      bytesBase64: Buffer.alloc(1024 * 1024, 2).toString("base64"),
      done: { mediaType: "application/octet-stream", displayName: "exact.bin" },
    });
    expect(last.ok && "ref" in last.result && last.result.ref.byteLength).toBe(25 * 1024 * 1024);
  });
});

describe("operator attachments, shared words", () => {
  it("says one line per file, with name, type, size and path", () => {
    const ref = { sha256: "a".repeat(64), byteLength: 3 * 1024 * 1024, mediaType: "application/pdf", displayName: "spec.pdf" } as ContentRef;
    expect(attachmentMailLines([ref], () => "/tmp/x/spec.pdf")).toEqual([
      "Attached: spec.pdf (application/pdf, 3.0 MB): /tmp/x/spec.pdf",
    ]);
    expect(attachmentSizeLabel(1)).toBe("1 byte");
    expect(attachmentSizeLabel(2048)).toBe("2 KB");
    expect(OPERATOR_ATTACHMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(isThumbnailType("image/HEIC")).toBe(true);
    expect(isThumbnailType("image/svg+xml")).toBe(false);
  });
});
