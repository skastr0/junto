import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allExamples } from "../src/cli/core/discovery";
import { planAttachFlags, splitCaption, type AttachFlags, type AttachProbe } from "../src/cli/core/signal-attach";
import { loadSignalRaiseArgs, SignalRaiseCliInput } from "../src/cli/core/signal-input";
import { WorkSocket } from "../src/cli/core/socket";
import { WORK_MAX_FRAME_BYTES } from "../src/shared/work-control";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const refOf = (bytes: Buffer) => ({ sha256: sha(bytes), byteLength: bytes.length });

type Staged = { readonly mediaType: string; readonly displayName?: string; readonly byteLength: number };
/** What crossed "the socket", and what each closed upload was said to be. */
let frames: Array<{ readonly op: string; readonly bytes: number }> = [];
let staged: Staged[] = [];

/** Main's side of `content.stage`, in memory: pieces by stage id, a reference on done. */
const socket = (() => {
  const open = new Map<string, Buffer[]>();
  return WorkSocket.of({
    call: (op, args) =>
      Effect.sync(() => {
        const frame = JSON.stringify({ token: "t", op, args });
        frames.push({ op, bytes: Buffer.byteLength(frame) });
        const { stageId, bytesBase64, done } = args as {
          stageId?: string;
          bytesBase64?: string;
          done?: { mediaType: string; displayName?: string };
        };
        const id = stageId ?? `stg_${String(open.size).padStart(32, "0")}`;
        const pieces = open.get(id) ?? [];
        if (bytesBase64 !== undefined) pieces.push(Buffer.from(bytesBase64, "base64"));
        open.set(id, pieces);
        const byteLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
        if (done === undefined) return { stageId: id, byteLength };
        const hash = createHash("sha256");
        for (const piece of pieces) hash.update(piece);
        open.delete(id);
        const { mediaType, displayName } = done;
        staged.push({ mediaType, ...(displayName === undefined ? {} : { displayName }), byteLength });
        return { ref: { sha256: hash.digest("hex"), byteLength, mediaType, displayName } };
      }),
  });
})();

let dir = "";
const at = (name: string): string => join(dir, name);
const load = (input: string, attach: ReadonlyArray<string> = []) =>
  Effect.runPromise(
    loadSignalRaiseArgs("feedback", input, undefined, attach).pipe(Effect.provideService(WorkSocket, socket)),
  );

beforeEach(() => {
  frames = [];
  staged = [];
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "junto-signal-attach-"));
  writeFileSync(at("before.png"), PNG);
  writeFileSync(at("after.png"), PNG);
  writeFileSync(at("a=b.png"), PNG);
  writeFileSync(at("notes.md"), "# notes");
  writeFileSync(at("build.zip"), "PK");
  mkdirSync(at("folder.png"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the one caption rule", () => {
  it("takes a value that is valid as written whole, and a caption only before a valid value", () => {
    const isFile = (value: string): boolean => value === "/tmp/a.png" || value === "/tmp/a=b.png";
    expect(splitCaption("/tmp/a.png", isFile)).toEqual({ value: "/tmp/a.png" });
    expect(splitCaption("Before=/tmp/a.png", isFile)).toEqual({ value: "/tmp/a.png", caption: "Before" });
    expect(splitCaption("Rail expanded = /tmp/a=b.png", isFile)).toEqual({ value: "/tmp/a=b.png", caption: "Rail expanded" });
    // A file with an equals sign in its name is that file.
    expect(splitCaption("/tmp/a=b.png", isFile)).toEqual({ value: "/tmp/a=b.png" });
    // A caption has no colon and no line break, and a caption before nothing valid is no caption.
    expect(splitCaption("a:b=/tmp/a.png", isFile)).toBeUndefined();
    expect(splitCaption("Before=/tmp/gone.png", isFile)).toBeUndefined();
    expect(splitCaption("=/tmp/a.png", isFile)).toBeUndefined();
  });
});

describe("planAttachFlags", () => {
  const probe: AttachProbe = {
    isFile: (path) => ["old.ts", "new.ts", "a,b.ts", "shot.png", "src/rate-limit.ts", "fix.patch"].includes(path),
    resolveCommit: (rev) => (rev === "HEAD" || rev === "abc1234" ? "a".repeat(40) : undefined),
  };
  const plan = (flags: AttachFlags) => {
    const planned = planAttachFlags(flags, probe);
    return planned.ok ? planned.plans : planned.error.message;
  };

  it("reads code with equals signs and colons in it as code, never as a caption", () => {
    expect(plan({ code: ["ts:const a = 1"] })).toEqual([
      { kind: "code", language: "ts", text: { from: "inline", text: "const a = 1" } },
    ]);
    expect(plan({ code: ["The guard=ts:if (a === b) return x ? 1 : 2;"] })).toEqual([
      { kind: "code", language: "ts", caption: "The guard", text: { from: "inline", text: "if (a === b) return x ? 1 : 2;" } },
    ]);
    expect(plan({ code: ["rate-limit.ts:@src/rate-limit.ts", "py:-"] })).toEqual([
      { kind: "code", language: "rate-limit.ts", text: { from: "file", path: "src/rate-limit.ts" } },
      { kind: "code", language: "py", text: { from: "stdin" } },
    ]);
    expect(plan({ code: ["no language here"] })).toMatch(/^--code: /);
  });

  it("reads code that starts with @ as code: a decorator or a CSS rule is not a file", () => {
    expect(plan({ code: ["ts:@Injectable()", "py:@property", "The rule=css:@media (min-width: 1px) { a { color: red } }"] })).toEqual([
      { kind: "code", language: "ts", text: { from: "inline", text: "@Injectable()" } },
      { kind: "code", language: "py", text: { from: "inline", text: "@property" } },
      { kind: "code", language: "css", caption: "The rule", text: { from: "inline", text: "@media (min-width: 1px) { a { color: red } }" } },
    ]);
    // A diff named by @ must be a file that exists; anything else must read as a diff.
    expect(plan({ diff: ["@gone.patch"] })).toMatch(/^--diff: /);
  });

  it("reads a diff from text, a file or stdin", () => {
    const text = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a = 1\n+a = 2\n";
    expect(plan({ diff: [text, "What changed=-", "@fix.patch", `The fix=${text}`] })).toEqual([
      { kind: "diff", text: { from: "inline", text } },
      { kind: "diff", caption: "What changed", text: { from: "stdin" } },
      { kind: "diff", text: { from: "file", path: "fix.patch" } },
      { kind: "diff", caption: "The fix", text: { from: "inline", text } },
    ]);
    // A hunk header is a diff, not a file named "@ -1 +1 @@".
    expect(plan({ diff: ["@@ -1 +1 @@\n-a\n+b"] })).toEqual([
      { kind: "diff", text: { from: "inline", text: "@@ -1 +1 @@\n-a\n+b" } },
    ]);
    expect(plan({ diff: ["just some words"] })).toMatch(/^--diff: /);
  });

  it("splits a compare at the one comma with a file on each side", () => {
    expect(plan({ compare: ["The limit=old.ts,new.ts", "a,b.ts,new.ts"] })).toEqual([
      { kind: "compare", caption: "The limit", before: { from: "file", path: "old.ts" }, after: { from: "file", path: "new.ts" } },
      { kind: "compare", before: { from: "file", path: "a,b.ts" }, after: { from: "file", path: "new.ts" } },
    ]);
    expect(plan({ compare: ["old.ts,gone.ts"] })).toMatch(/^--compare: /);
    expect(plan({ compare: ["old.ts"] })).toContain("JSON form");
  });

  it("takes a commit by anything git resolves and a video by a web address", () => {
    expect(plan({ commit: ["HEAD", "The fix=abc1234"], video: ["The run=https://host/run.mp4?t=1&a=b"] })).toEqual([
      { kind: "commit", rev: "HEAD" },
      { kind: "commit", caption: "The fix", rev: "abc1234" },
      { kind: "video", caption: "The run", url: "https://host/run.mp4?t=1&a=b" },
    ]);
    expect(plan({ commit: ["nope"] })).toMatch(/^--commit: /);
    expect(plan({ video: ["ssh://host/run.mp4"] })).toMatch(/^--video: /);
  });

  it("orders the card: attach, code, diff, compare, commit, video", () => {
    const plans = plan({ video: ["https://h/v.mp4"], commit: ["HEAD"], attach: ["shot.png"], code: ["ts:x"] });
    expect(Array.isArray(plans) && plans.map((item) => item.kind)).toEqual(["file", "code", "commit", "video"]);
  });

  it("refuses by naming the flag, what a valid value looks like, and one example", () => {
    const planned = planAttachFlags({ attach: ["Before=gone.png"] }, probe);
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.error.message).toContain("--attach");
      expect(planned.error.hint).toContain("a path to a file that exists");
      expect(planned.error.hint).toContain('--attach "Before=/abs/before.png"');
    }
  });
});

describe("--attach on the needs-you commands", () => {
  it("uploads each file in order and names it by reference: no bytes and no path in the signal", async () => {
    const args = await load("ready", [`Before=${at("before.png")}`, at("after.png"), at("a=b.png")]);
    expect(args).toEqual({
      kind: "feedback",
      text: "ready",
      attach: [{ ref: refOf(PNG), caption: "Before" }, { ref: refOf(PNG) }, { ref: refOf(PNG) }],
    });
    expect(JSON.stringify(args)).not.toContain(dir);
    expect(staged).toEqual([
      { mediaType: "image/png", displayName: "before.png", byteLength: PNG.length },
      { mediaType: "image/png", displayName: "after.png", byteLength: PNG.length },
      { mediaType: "image/png", displayName: "a=b.png", byteLength: PNG.length },
    ]);
    expect(frames.every((frame) => frame.op === "content.stage")).toBe(true);
  });

  it("takes the same list from the JSON input", async () => {
    const args = await load(
      JSON.stringify({ text: "ready", attach: [{ path: at("notes.md"), caption: "Notes" }] }),
    );
    expect(args.attach).toEqual([{ ref: refOf(Buffer.from("# notes")), caption: "Notes" }]);
    expect(staged).toEqual([{ mediaType: "text/markdown", displayName: "notes.md", byteLength: 7 }]);
  });

  it("sends no attach field when nothing is attached", async () => {
    expect(await load("ready")).toEqual({ kind: "feedback", text: "ready" });
    expect(frames).toEqual([]);
  });

  it("refuses, naming the file: a missing one, a folder, given twice", async () => {
    await expect(load("x", [at("gone.png")])).rejects.toThrow(/gone\.png/);
    await expect(load("x", [at("folder.png")])).rejects.toThrow(/--attach: .*folder\.png" is not a path to a file that exists/);
    await expect(
      load(JSON.stringify({ text: "x", attach: [{ path: at("before.png") }] }), [at("after.png")]),
    ).rejects.toThrow(/attachments given twice/);
    await expect(load(JSON.stringify({ text: "x", attach: [{ path: at("before.png"), bytes: "x" }] }))).rejects.toThrow();
  });

  it("uploads nothing when one of the files is refused", async () => {
    await expect(load("x", [at("before.png"), at("gone.png")])).rejects.toThrow(/gone\.png/);
    expect(frames).toEqual([]);
  });

  it("attaches a file of any kind, as a file", async () => {
    const args = await load("x", [at("build.zip")]);
    expect(args.attach).toEqual([{ ref: refOf(Buffer.from("PK")) }]);
    // Two letters are text; main and the preview judge the real bytes again.
    expect(staged).toEqual([{ mediaType: "text/plain", displayName: "build.zip", byteLength: 2 }]);
  });

  it("sets no count of its own: fifty files go as fifty", async () => {
    const args = await load("x", Array.from({ length: 50 }, () => at("before.png")));
    expect(args.attach).toHaveLength(50);
    expect(staged).toHaveLength(50);
  });

  it("sets no size of its own: a file larger than a frame goes in pieces that each fit", async () => {
    const huge = at("huge.png");
    // Sparse: a PNG signature, then twenty megabytes of nothing.
    writeFileSync(huge, PNG);
    truncateSync(huge, 20 * 1024 * 1024);
    expect(20 * 1024 * 1024).toBeGreaterThan(WORK_MAX_FRAME_BYTES);
    const args = await load("x", [huge]);
    expect(args.attach?.[0]).toMatchObject({ ref: { byteLength: 20 * 1024 * 1024 } });
    expect(staged).toEqual([{ mediaType: "image/png", displayName: "huge.png", byteLength: 20 * 1024 * 1024 }]);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.bytes).toBeLessThan(WORK_MAX_FRAME_BYTES);
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(1024);
  }, 60_000);

  it("uploads inline code, a diff and a compare as named text, and sends a link as its address", async () => {
    writeFileSync(at("old.ts"), "const limit = 10;\n");
    writeFileSync(at("new.ts"), "const limit = 20;\n");
    const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a = 1\n+a = 2\n";
    const args = await Effect.runPromise(
      loadSignalRaiseArgs("feedback", "ready", undefined, {
        code: ["The guard=ts:if (a === b) return;"],
        diff: [diff],
        compare: [`The limit=${at("old.ts")},${at("new.ts")}`],
        video: ["The run=https://media.example.com/run.mp4"],
      }).pipe(Effect.provideService(WorkSocket, socket)),
    );
    expect(args.attach).toEqual([
      { ref: refOf(Buffer.from("if (a === b) return;")), caption: "The guard" },
      { ref: refOf(Buffer.from(diff)) },
      { kind: "compare", before: refOf(Buffer.from("const limit = 10;\n")), after: refOf(Buffer.from("const limit = 20;\n")), name: "new.ts", caption: "The limit" },
      { kind: "link", url: "https://media.example.com/run.mp4", caption: "The run" },
    ]);
    expect(staged.map((file) => [file.displayName, file.mediaType])).toEqual([
      ["snippet.ts", "text/plain"],
      ["changes.diff", "text/x-diff"],
      ["old.ts", "text/plain"],
      ["new.ts", "text/plain"],
    ]);
    expect(JSON.stringify(args)).not.toContain(dir);
  });

  it("takes every kind from the JSON list, in list order, with two inline texts as a compare", async () => {
    const args = await load(
      JSON.stringify({
        text: "ready",
        attach: [
          { url: "https://media.example.com/run.mp4" },
          { before: "a = 1\n", after: "a = 2\n", language: "py", caption: "The change" },
          { code: "print(a)", language: "py" },
          { diff: "--- a\n+++ b\n" },
          { path: at("before.png"), caption: "Before" },
        ],
      }),
    );
    expect(args.attach).toEqual([
      { kind: "link", url: "https://media.example.com/run.mp4" },
      { kind: "compare", before: refOf(Buffer.from("a = 1\n")), after: refOf(Buffer.from("a = 2\n")), name: "snippet.py", caption: "The change" },
      { ref: refOf(Buffer.from("print(a)")) },
      { ref: refOf(Buffer.from("--- a\n+++ b\n")) },
      { ref: refOf(PNG), caption: "Before" },
    ]);
    expect(staged.map((file) => file.displayName)).toEqual(["before.py", "after.py", "snippet.py", "changes.diff", "before.png"]);
  });

  it("refuses a JSON item with two shapes, and uploads nothing when a later item is bad", async () => {
    await expect(load(JSON.stringify({ text: "x", attach: [{ code: "a", language: "ts", diff: "b" }] }))).rejects.toThrow();
    await expect(
      Effect.runPromise(
        loadSignalRaiseArgs("feedback", "x", undefined, { code: ["ts:fine"], video: ["https://me:pw@host/v.mp4"] }).pipe(
          Effect.provideService(WorkSocket, socket),
        ),
      ),
    ).rejects.toThrow(/password/);
    expect(frames).toEqual([]);
  });

  it("decodes with the schema it shows: every example input is accepted as written", async () => {
    const examples = allExamples.filter((example) => /^signal\.(escalate|blocked|feedback)$/u.test(example.command_id));
    expect(examples.length).toBeGreaterThanOrEqual(8);
    for (const example of examples) {
      const input = example.input as { readonly text: string; readonly attach?: ReadonlyArray<Record<string, unknown>> };
      expect(input).not.toHaveProperty("kind");
      // Paths and commits in an example are not here; those items are checked by shape only.
      const local = (item: Record<string, unknown>): boolean => "path" in item || "commit" in item;
      const { attach, ...rest } = input;
      const kept = attach?.filter((item) => !local(item)) ?? [];
      expect(await load(JSON.stringify(kept.length > 0 ? { ...rest, attach: kept } : rest))).toMatchObject({ kind: "feedback", text: input.text });
      expect(Result.isSuccess(Schema.decodeUnknownResult(SignalRaiseCliInput)(input))).toBe(true);
    }
  });
});
