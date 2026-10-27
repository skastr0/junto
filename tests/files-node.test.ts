import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { BUILD_FEATURES, filesOn } from "../src/shared/features";
import { UNNAMED_MACHINE } from "../src/shared/canvas-copy";
import { Node } from "../src/shared/model";
import { titleOf } from "../src/shared/model/title";
import { newFiles, newNote } from "../src/renderer/lib/model-factories";
import { connected } from "../src/renderer/lib/model-edits";
import { canConnect, targetPlanOn } from "../src/renderer/lib/edge-mutations";
import { toFlowOfCanvas } from "../src/renderer/lib/convert";
import { nodeSurfaceKind } from "../src/renderer/lib/activate-node-surface";
import { cardDropNotice, countLine } from "../src/renderer/lib/files-card";
import { consumeWorkDetailOpen, filesDetailOpening, openWorkDetail } from "../src/renderer/lib/work-detail-open";
import { nodeCatalogEntries } from "../src/renderer/components/node-palette/NodeCatalogGrid";
import { canvasOf, seat } from "./support/model-nodes";
import type { FilePath } from "../src/shared/files";

// Ship builds Files as experimental, so the operator's toggle decides; all-on
// builds it on, and the toggle changes nothing there.
const EXPERIMENTAL = BUILD_FEATURES.files === "experimental";
const ON = { files: true } as const;
const OFF = { files: false } as const;
const at = { x: 12, y: 34, z: 0 };
const made = () => newFiles(at, { host: "studio", root: "/Users/me/proj" }, ON);

describe("files node factory", () => {
  it("makes a files node on its machine with the folder, and no label", () => {
    const node = made();
    expect(node.kind).toBe("files");
    expect(node.host).toBe("studio");
    expect(node.root).toBe("/Users/me/proj");
    expect(node.id.startsWith("files-")).toBe(true);
    expect(node).not.toHaveProperty("label");
    expect(Schema.decodeUnknownSync(Node)(node)).toEqual(node);
  });

  it("is called by its folder's name until the operator writes one", () => {
    expect(titleOf(made())).toBe("proj");
    expect(titleOf({ ...made(), root: "/Users/me/proj/" })).toBe("proj");
    expect(titleOf({ ...made(), label: "site" })).toBe("site");
  });

  it.runIf(EXPERIMENTAL)("refuses with the files toggle off", () => {
    expect(filesOn(OFF)).toBe(false);
    expect(filesOn(undefined)).toBe(false);
    expect(() => newFiles(at, { host: "studio", root: "/tmp" }, OFF)).toThrow(/disabled/);
    expect(() => newFiles(at, { host: "studio", root: "/tmp" }, undefined)).toThrow(/disabled/);
  });

  it.runIf(BUILD_FEATURES.files === true)("is made whatever the toggle says when the build has it on", () => {
    expect(newFiles(at, { host: "studio", root: "/tmp" }, OFF).kind).toBe("files");
    expect(newFiles(at, { host: "studio", root: "/tmp" }, undefined).kind).toBe("files");
  });

  it("refuses the unnamed machine, a bad name, and a folder that is not absolute", () => {
    expect(() => newFiles(at, { host: UNNAMED_MACHINE, root: "/tmp" }, ON)).toThrow();
    expect(() => newFiles(at, { host: "", root: "/tmp" }, ON)).toThrow();
    expect(() => newFiles(at, { host: "studio", root: "~/proj" }, ON)).toThrow();
    expect(() => newFiles(at, { host: "studio", root: "proj" }, ON)).toThrow();
    expect(() => newFiles(at, { host: "studio", root: " " }, ON)).toThrow();
  });
});

describe("files in the palette", () => {
  it.runIf(EXPERIMENTAL)("is offered only with the toggle on", () => {
    expect(nodeCatalogEntries(filesOn(OFF)).map((entry) => entry.id)).not.toContain("files");
    expect(nodeCatalogEntries(filesOn(undefined)).map((entry) => entry.id)).not.toContain("files");
    expect(nodeCatalogEntries(filesOn(ON)).map((entry) => entry.id)).toContain("files");
  });

  it.runIf(BUILD_FEATURES.files === true)("is offered whatever the toggle says when the build has it on", () => {
    expect(nodeCatalogEntries(filesOn(OFF)).map((entry) => entry.id)).toContain("files");
    expect(nodeCatalogEntries(filesOn(undefined)).map((entry) => entry.id)).toContain("files");
  });

  it("sits in the work catalog right after Git", () => {
    const ids = nodeCatalogEntries(true).map((entry) => entry.id);
    expect(ids.indexOf("files")).toBe(ids.indexOf("git") + 1);
    expect(nodeCatalogEntries(true).find((entry) => entry.id === "files")?.category).toBe("sinks");
  });
});

describe("files takes no wire", () => {
  it("draws no connectors", () => {
    const files = made();
    const note = newNote({ x: 100, y: 0, z: 1 });
    const { nodes } = toFlowOfCanvas(canvasOf([files, note]), { canvasName: "test", resolveActorRef: () => undefined, heldBy: {} });
    expect(nodes.find((n) => n.id === files.id)?.connectable).toBe(false);
  });

  it("says Files cannot take connections, either way round", () => {
    const files = made();
    const canvas = canvasOf([files, seat("a")]);
    expect(connected(canvas, { id: "w1", from: "a", to: files.id })).toMatchObject({ ok: false, why: "files" });
    expect(connected(canvas, { id: "w2", from: files.id, to: "a" })).toMatchObject({ ok: false, why: "files" });
    expect(canConnect(canvas.nodes.get(files.id), canvas.nodes.get("a" as never))).toBe(false);
    expect(targetPlanOn(canvas, ["a"], files.id).skipped).toEqual([{ source: "a", reason: "invalid-target" }]);
    expect(targetPlanOn(canvas, [files.id], "a").toAdd).toEqual([]);
  });

  it("opens the work surface", () => {
    expect(nodeSurfaceKind(made())).toBe("work");
  });
});

describe("a drop on the card", () => {
  const describeError = () => "Refused.";
  const path = (p: string) => p as FilePath;

  it("names the copy short enough for the card, and in full for the tooltip", () => {
    expect(cardDropNotice(["/a/notes.md"], { ok: true, value: [{ path: path("notes.md"), dir: false }] }, "proj", describeError))
      .toEqual({ text: "Copied notes.md.", full: "Copied notes.md into proj.", failed: false });
    expect(cardDropNotice(["/a/notes.md"], { ok: true, value: [{ path: path("notes 2.md"), dir: false }] }, "proj", describeError))
      .toEqual({ text: "Copied as notes 2.md.", full: "Copied notes.md into proj as notes 2.md.", failed: false });
    const three = ["/a/x.md", "/a/y.md", "/a/z.md"];
    expect(cardDropNotice(three, { ok: true, value: three.map((s) => ({ path: path(s.slice(3)), dir: false })) }, "proj", describeError))
      .toEqual({ text: "Copied 3 files.", full: "Copied 3 files into proj.", failed: false });
  });

  it("says a refusal, and that only Finder files drop", () => {
    expect(cardDropNotice(["/a/x"], { ok: false, error: "root-missing" }, "proj", describeError))
      .toEqual({ text: "Nothing was copied.", full: "Nothing was copied into proj. Refused.", failed: true });
    expect(cardDropNotice([], undefined, "proj", describeError)?.failed).toBe(true);
  });
});

describe("the card's count", () => {
  it("counts files, marks a capped count, and says nothing when refused or not yet counted", () => {
    expect(countLine({ ok: true, value: { files: 1, capped: false } })).toBe("1 file");
    expect(countLine({ ok: true, value: { files: 0, capped: false } })).toBe("0 files");
    expect(countLine({ ok: true, value: { files: 1204, capped: false } })).toBe("1,204 files");
    expect(countLine({ ok: true, value: { files: 100_000, capped: true } })).toBe("100,000+ files");
    expect(countLine({ ok: false, error: "root-missing" })).toBeUndefined();
    expect(countLine(undefined)).toBeUndefined();
  });
});

describe("an open that names a page", () => {
  it("reaches the Files modal with its file and page", () => {
    openWorkDetail("files-1", { itemId: "docs/brief.pdf", page: 3 });
    const consumed = consumeWorkDetailOpen("files-1");
    expect(consumed).toEqual({ itemId: "docs/brief.pdf", page: 3 });
    expect(filesDetailOpening(consumed!)).toEqual({ initialItemId: "docs/brief.pdf", initialPage: 3 });
  });

  it("carries no page when none was named, nor after a paged open was consumed", () => {
    openWorkDetail("files-1", { itemId: "docs/brief.pdf", page: 3 });
    consumeWorkDetailOpen("files-1");
    openWorkDetail("files-1", { itemId: "notes.md" });
    const consumed = consumeWorkDetailOpen("files-1");
    expect(consumed).toEqual({ itemId: "notes.md" });
    expect(filesDetailOpening(consumed!)).toEqual({ initialItemId: "notes.md" });
    openWorkDetail("files-1", { itemId: "a.pdf", page: 0 });
    expect(filesDetailOpening(consumeWorkDetailOpen("files-1")!)).toEqual({ initialItemId: "a.pdf" });
  });

  it("is consumed only by the node it names", () => {
    openWorkDetail("files-1", { itemId: "a.pdf", page: 2 });
    expect(consumeWorkDetailOpen("files-2")).toBeNull();
    expect(consumeWorkDetailOpen("files-1")?.page).toBe(2);
  });
});
