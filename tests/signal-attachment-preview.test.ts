/**
 * A preview of a seat's file that is not on this machine yet: a card's
 * thumb asks nothing of the seat's machine and shows the file by name and
 * the size its reference states; only the operator's open (the full
 * variant) pulls it.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSignalAttachmentPreview, type SignalAttachmentPreviewDeps } from "../src/main/junto/signals/attachment-preview";
import { previewTile } from "../src/renderer/components/preview/use-previews";
import type { AgentSignal } from "../src/shared/agent-signals";
import type { ContentRef } from "../src/shared/content";

const GIB = 1024 * 1024 * 1024;
const words = Buffer.from("what the seat wrote\n");
const refOf = (bytes: Buffer, displayName: string, byteLength = bytes.length): ContentRef =>
  ({ sha256: createHash("sha256").update(bytes).digest("hex"), byteLength, mediaType: "application/octet-stream", displayName }) as ContentRef;
// A seat names its file: a gigabyte can be called a screenshot.
const huge = refOf(Buffer.from("huge"), "screenshot.png", GIB);
const notes = refOf(words, "notes.txt");
const signal = {
  signalId: "sig-1", canvasName: "factory", nodeId: "peer", kind: "blocked", text: "look", state: "open", createdAt: 1,
  attachments: [{ ref: huge }, { ref: notes }, { kind: "compare", before: notes, after: huge, name: "rate-limit.ts" }],
} as unknown as AgentSignal;
const render = (variant: "thumb" | "full") => ({ variant, thumbEdge: 96 });

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Nothing held here until a pull lands `notes` in the store. */
const machine = async () => {
  const dir = await mkdtemp(join(tmpdir(), "junto-attachment-preview-"));
  dirs.push(dir);
  const held = new Map<string, string>();
  const pulls: Array<ReadonlyArray<string>> = [];
  const deps: SignalAttachmentPreviewDeps = {
    open: async (ref) => {
      const path = held.get(ref.sha256);
      return path === undefined ? ({ state: "missing" } as never) : ({ state: "verified", path, byteLength: ref.byteLength, mediaType: ref.mediaType } as never);
    },
    pull: async (named, refs) => {
      pulls.push(refs.map((ref) => ref.displayName ?? ""));
      const path = join(dir, "notes");
      await writeFile(path, words);
      held.set(notes.sha256, path);
      return named;
    },
  };
  return { deps, pulls };
};

it("a card's thumb pulls nothing, and shows the file by name and the size its reference states", async () => {
  const { deps, pulls } = await machine();
  const tiles = await Promise.all([0, 1, 2].map((index) => readSignalAttachmentPreview(deps, { signal, index, render: render("thumb") })));
  expect(pulls).toEqual([]);
  expect(tiles).toEqual([
    { ok: true, kind: "file", name: "screenshot.png", byteLength: GIB, extension: "png" },
    { ok: true, kind: "file", name: "notes.txt", byteLength: words.length, extension: "txt" },
    { ok: true, kind: "file", name: "rate-limit.ts", byteLength: words.length + GIB, extension: "ts" },
  ]);
  // The tile says what the operator would open.
  expect(previewTile({ path: "attachment:0", name: "screenshot.png", kind: "image", attachment: 0 } as never, tiles[0]!)).toMatchObject({
    state: "ready", extension: "png", detail: "1024.0 MB",
  });
});

it("the operator's open pulls the file from the seat's machine, then reads it", async () => {
  const { deps, pulls } = await machine();
  const opened = await readSignalAttachmentPreview(deps, { signal, index: 1, render: render("full") });
  expect(pulls).toEqual([["notes.txt"]]);
  expect(opened).toMatchObject({ ok: true, kind: "text", name: "notes.txt", text: words.toString("utf8") });
  // Held now: a thumb reads it as it is, and pulls nothing more.
  expect(await readSignalAttachmentPreview(deps, { signal, index: 1, render: render("thumb") })).toMatchObject({ ok: true, kind: "text" });
  expect(pulls).toHaveLength(1);
});

it("names nothing past the signal's own list", async () => {
  const { deps, pulls } = await machine();
  expect(await readSignalAttachmentPreview(deps, { signal, index: 9, render: render("full") })).toEqual({ ok: false, reason: "not-named" });
  expect(await readSignalAttachmentPreview(deps, { signal: undefined, index: 0, render: render("full") })).toEqual({ ok: false, reason: "not-named" });
  expect(pulls).toEqual([]);
});
