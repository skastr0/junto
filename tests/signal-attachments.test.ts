/**
 * Files on a signal, main's side: the seat uploaded them (`content.stage`),
 * the signal names them by reference, and main takes them from the store.
 * Real content store and manifest in a temp home; no socket.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSignalAttachment } from "../src/shared/agent-signals";
import { ContentManifest } from "../src/main/junto/content/manifest";
import { contentStoreRoot } from "../src/main/junto/content/paths";
import { ContentService, createContentService } from "../src/main/junto/content/service";
import {
  attachmentName,
  claimSignalAttachments,
  signalAttachmentOwner,
} from "../src/main/junto/signals/attachments";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { handleContentStage } from "../src/main/junto/work/content-stage";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const fileRef = (attachment: AgentSignalAttachment) => {
  if ("kind" in attachment) throw new Error(`expected a file, got a ${attachment.kind}`);
  return attachment.ref;
};
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const atlas = { canvasName: "factory", nodeId: "atlas" };
const signal = { ...atlas, signalId: "s1" };

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

const boot = async () => {
  home = await mkdtemp(join(tmpdir(), "junto-signal-attachments-"));
  runtime = ManagedRuntime.make(
    ContentManifest.layer.pipe(Layer.provideMerge(makeStateEngineLive(join(home, "junto.db")))),
  );
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const manifest = await runtime.runPromise(ContentManifest);
  const content = createContentService(sql, manifest, contentStoreRoot(home));
  /** A seat uploads one file, as the CLI would, and gets what to name it by. */
  const stage = async (name: string, bytes: Buffer, mediaType = "application/octet-stream", seat = atlas) => {
    const answer = await Effect.runPromise(
      handleContentStage(seat, {
        bytesBase64: bytes.toString("base64"),
        done: { mediaType, displayName: name },
      }).pipe(Effect.provideService(ContentService, content)),
    );
    if (!("ref" in answer)) throw new Error("the upload did not close");
    return { ref: { sha256: answer.ref.sha256, byteLength: answer.ref.byteLength } };
  };
  const claim = (inputs: Parameters<typeof claimSignalAttachments>[2], to = signal) =>
    Effect.runPromise(Effect.result(claimSignalAttachments(content, to, inputs)));
  const owners = async (bytes: Buffer) =>
    (await Effect.runPromise(content.listRefs(sha(bytes)))).map((row) => row.owner.recordId);
  return { content, stage, claim, owners };
};

describe("claimSignalAttachments", () => {
  it("takes images and text in order, typed by their bytes and named as uploaded", async () => {
    const { stage, claim, owners } = await boot();
    const notes = Buffer.from("# hi");
    // The type the seat declared is not what the signal records.
    const result = await claim([
      { ...(await stage("before.png", PNG, "text/plain")), caption: "  Before  " },
      await stage("notes.md", notes),
    ]);
    expect(Result.isSuccess(result) && result.success).toEqual([
      { ref: { sha256: sha(PNG), byteLength: PNG.length, mediaType: "image/png", displayName: "before.png" }, caption: "Before" },
      { ref: { sha256: sha(notes), byteLength: notes.length, mediaType: "text/markdown", displayName: "notes.md" } },
    ]);
    expect(await owners(PNG)).toEqual(["signal:s1"]);
    expect(await owners(notes)).toEqual(["signal:s1"]);
  });

  it("sets no count and no size: two hundred files, and one of many megabytes", async () => {
    const { stage, claim } = await boot();
    const many = [];
    for (let n = 0; n < 200; n += 1) many.push(await stage(`${n}.txt`, Buffer.from(`file ${n}`)));
    const result = await claim(many);
    expect(Result.isSuccess(result) && result.success.length).toBe(200);

    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const taken = await claim([await stage("big.png", big)], { ...atlas, signalId: "s2" });
    expect(Result.isSuccess(taken) && fileRef(taken.success[0]!).byteLength).toBe(big.length);
  }, 60_000);

  it("holds a file named twice once", async () => {
    const { stage, claim, owners } = await boot();
    const first = await stage("before.png", PNG);
    await stage("after.png", PNG);
    const result = await claim([first, first]);
    expect(Result.isSuccess(result) && result.success.map((attachment) => fileRef(attachment).displayName)).toEqual([
      "before.png",
      "before.png",
    ]);
    expect((await owners(PNG)).filter((recordId) => recordId === "signal:s1")).toHaveLength(1);
  });

  it("refuses a file another seat uploaded, and one never uploaded", async () => {
    const { stage, claim } = await boot();
    const theirs = await stage("theirs.png", PNG, "image/png", { canvasName: "factory", nodeId: "vega" });
    const other = await claim([theirs]);
    expect(Result.isFailure(other) && other.failure).toMatchObject({ path: "attach[0]" });
    const never = await claim([{ ref: { sha256: "0".repeat(64), byteLength: 3 } } as never]);
    expect(Result.isFailure(never) && never.failure.message).toContain("not uploaded by this seat");
  });

  it("takes a file of any kind as a file, and a caption of any length", async () => {
    const { stage, claim, owners } = await boot();
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01]);
    const words = "x".repeat(500);
    // Declared as an image: the bytes and the name decide, not the claim.
    const taken = await claim([
      await stage("build.zip", zip, "image/png"),
      { ...(await stage("fake.png", Buffer.from("text"))), caption: words },
    ]);
    expect(Result.isSuccess(taken) && taken.success.map((attachment) => [fileRef(attachment).displayName, fileRef(attachment).mediaType, attachment.caption])).toEqual([
      ["build.zip", "application/octet-stream", undefined],
      // Text, whatever it is named.
      ["fake.png", "text/plain", words],
    ]);
    expect(await owners(zip)).toEqual(["signal:s1"]);
  });

  it("takes a compare of two texts, a commit by its full id and a link by its address", async () => {
    const { stage, claim, owners } = await boot();
    const before = Buffer.from("const limit = 10;\n");
    const after = Buffer.from("const limit = 20;\n");
    const head = "a".repeat(40);
    const taken = await claim([
      { kind: "compare", before: (await stage("before.ts", before)).ref, after: (await stage("after.ts", after)).ref, name: "/tmp/rate-limit.ts", caption: "The limit" },
      { kind: "commit", sha: head.toUpperCase(), caption: " The fix " },
      { kind: "link", url: " https://media.example.com/demo/run.mp4?t=1 " },
    ] as never);
    expect(Result.isSuccess(taken) && taken.success).toEqual([
      {
        kind: "compare",
        before: { sha256: sha(before), byteLength: before.length, mediaType: "text/plain", displayName: "before.ts" },
        after: { sha256: sha(after), byteLength: after.length, mediaType: "text/plain", displayName: "after.ts" },
        name: "rate-limit.ts",
        caption: "The limit",
      },
      { kind: "commit", sha: head, caption: "The fix" },
      { kind: "link", url: "https://media.example.com/demo/run.mp4?t=1" },
    ]);
    expect(await owners(before)).toEqual(["signal:s1"]);
    expect(await owners(after)).toEqual(["signal:s1"]);
  });

  it("refuses a short commit id, an address that is not the web or carries a password, and a compare that is not text", async () => {
    const { stage, claim, owners } = await boot();
    const message = async (input: unknown): Promise<string | false> => {
      const result = await claim([input] as never);
      return Result.isFailure(result) && result.failure.message;
    };
    expect(await message({ kind: "commit", sha: "abc1234" })).toContain("forty hex");
    expect(await message({ kind: "link", url: "ssh://box/home/me/run.mp4" })).toContain("http");
    expect(await message({ kind: "link", url: "file:///etc/passwd" })).toContain("http");
    expect(await message({ kind: "link", url: "https://me:secret@example.com/a.mp4" })).toContain("password");
    expect(await message({ kind: "link", url: "not an address" })).toContain("not a web address");
    const text = Buffer.from("text");
    const picture = await stage("a.png", PNG);
    expect(await message({ kind: "compare", before: (await stage("a.txt", text)).ref, after: picture.ref })).toContain("two texts");
    // Refused: nothing of it is kept.
    expect(await owners(text)).not.toContain("signal:s1");
    expect(await owners(PNG)).not.toContain("signal:s1");
  });

  it("keeps nothing of a refused signal", async () => {
    const { stage, claim, owners } = await boot();
    const refused = await claim([await stage("a.png", PNG), { ref: { sha256: "0".repeat(64), byteLength: 3 } } as never]);
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({ path: "attach[1]" });
    expect(await owners(PNG)).not.toContain("signal:s1");
  });
});

describe("attachment names and owners", () => {
  it("keeps only the file name of whatever name it is given", () => {
    expect(attachmentName("/Users/me/shots/before.png")).toBe("before.png");
    expect(attachmentName("C:\\shots\\before.png")).toBe("before.png");
    expect(attachmentName("a\u0000b.png")).toBe("ab.png");
    expect(attachmentName("///")).toBe("");
  });

  it("holds a signal's files under the signal in the content store", () => {
    expect(signalAttachmentOwner({ signalId: "s1", canvasName: "factory", nodeId: "atlas" })).toEqual({
      kind: "other",
      canvasName: "factory",
      nodeId: "atlas",
      recordId: "signal:s1",
    });
  });
});
