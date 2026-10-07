import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allExamples } from "../src/cli/core/discovery";
import { loadSignalRaiseArgs, parseAttachFlag } from "../src/cli/core/signal-input";
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

describe("parseAttachFlag", () => {
  const none = (): boolean => false;
  it("reads a bare path, and a caption before the first equals sign only", () => {
    expect(parseAttachFlag("/tmp/a.png", none)).toEqual({ path: "/tmp/a.png" });
    expect(parseAttachFlag("Before=/tmp/a.png", none)).toEqual({ path: "/tmp/a.png", caption: "Before" });
    expect(parseAttachFlag("Rail expanded = /tmp/a=b.png", none)).toEqual({
      path: "/tmp/a=b.png",
      caption: "Rail expanded",
    });
    expect(parseAttachFlag("=/tmp/a.png", none)).toEqual({ path: "=/tmp/a.png" });
  });

  it("takes a value that is a file as that file, whatever it contains", () => {
    expect(parseAttachFlag("/tmp/a=b.png", (path) => path === "/tmp/a=b.png")).toEqual({ path: "/tmp/a=b.png" });
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
    await expect(load("x", [at("folder.png")])).rejects.toThrow(/folder\.png: not a regular file/);
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
    expect(args.attach?.[0]?.ref.byteLength).toBe(20 * 1024 * 1024);
    expect(staged).toEqual([{ mediaType: "image/png", displayName: "huge.png", byteLength: 20 * 1024 * 1024 }]);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.bytes).toBeLessThan(WORK_MAX_FRAME_BYTES);
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(1024);
  }, 60_000);

  it("decodes with the schema it shows: every example input is accepted as written", async () => {
    const examples = allExamples.filter((example) => /^signal\.(escalate|blocked|feedback)$/u.test(example.command_id));
    expect(examples.length).toBeGreaterThanOrEqual(4);
    for (const example of examples) {
      const input = example.input as { readonly text: string; readonly attach?: ReadonlyArray<{ readonly path: string }> };
      expect(input).not.toHaveProperty("kind");
      // Paths in an example are not files here; the shape is what is checked.
      const { attach: _attach, ...rest } = input;
      expect(await load(JSON.stringify(rest))).toMatchObject({ kind: "feedback", text: input.text });
    }
  });
});
