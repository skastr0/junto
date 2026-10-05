import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSignalRaiseArgs, parseAttachFlag } from "../src/cli/core/signal-input";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir = "";
const at = (name: string): string => join(dir, name);
const load = (input: string, attach: ReadonlyArray<string> = []) =>
  Effect.runPromise(loadSignalRaiseArgs("feedback", input, undefined, attach));

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
  it("sends each file's bytes and name in order, never its path", async () => {
    const args = await load("ready", [`Before=${at("before.png")}`, at("after.png"), at("a=b.png")]);
    expect(args).toEqual({
      kind: "feedback",
      text: "ready",
      attach: [
        { name: "before.png", caption: "Before", bytesBase64: PNG.toString("base64") },
        { name: "after.png", bytesBase64: PNG.toString("base64") },
        { name: "a=b.png", bytesBase64: PNG.toString("base64") },
      ],
    });
    expect(JSON.stringify(args)).not.toContain(dir);
  });

  it("takes the same list from the JSON input", async () => {
    const args = await load(
      JSON.stringify({ text: "ready", attach: [{ path: at("notes.md"), caption: "Notes" }] }),
    );
    expect(args.attach).toEqual([
      { name: "notes.md", caption: "Notes", bytesBase64: Buffer.from("# notes").toString("base64") },
    ]);
  });

  it("sends no attach field when nothing is attached", async () => {
    expect(await load("ready")).toEqual({ kind: "feedback", text: "ready" });
  });

  it("refuses, naming the file: a missing one, a folder, a type no preview shows, too many, given twice", async () => {
    await expect(load("x", [at("gone.png")])).rejects.toThrow(/gone\.png/);
    await expect(load("x", [at("folder.png")])).rejects.toThrow(/folder\.png: not a regular file/);
    await expect(load("x", [at("build.zip")])).rejects.toThrow(/build\.zip: only images/);
    await expect(load("x", Array.from({ length: 13 }, () => at("before.png")))).rejects.toThrow(/at most 12 files/);
    await expect(
      load(JSON.stringify({ text: "x", attach: [{ path: at("before.png") }] }), [at("after.png")]),
    ).rejects.toThrow(/attachments given twice/);
    await expect(load(JSON.stringify({ text: "x", attach: [{ path: at("before.png"), bytes: "x" }] }))).rejects.toThrow();
  });
});
