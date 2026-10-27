import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { applyPatches, asPadElementId, emptyPad, type Pad } from "../src/shared/pad";
import { padSvgPalette } from "../src/shared/pad-project";
import { padDiff, padToScene, sceneToPad, settle, type SceneElement } from "../src/renderer/components/pad/excalidraw/pad-excalidraw-model";

const pal = padSvgPalette("dark");
const id = asPadElementId;
const ref = { sha256: "a".repeat(64), byteLength: 10, mediaType: "image/png" } as never;

const pad: Pad = {
  ...emptyPad(),
  revision: 7,
  shapes: [
    { id: id("a"), type: "box", x: 0, y: 0, w: 120, h: 60, z: 0, text: "Plan", status: "active" },
    { id: id("b"), type: "ellipse", x: 300, y: 0, w: 100, h: 80, z: 1, fill: "#223344" },
    { id: id("c"), type: "triangle", x: 0, y: 200, w: 90, h: 70, z: 2, stroke: "#ff0000" },
    { id: id("d"), type: "label", x: 300, y: 200, w: 120, h: 20, z: 3, text: "note" },
    { id: id("card"), type: "box", x: 500, y: 0, w: 240, h: 120, z: 4, text: "junto://canvas/factory?node=task-1&item=01M5Y9YRQG8MP8GPPH3QVQ44TM" },
  ],
  edges: [{ id: id("e"), from: id("a"), to: id("b"), fromSide: "right", toSide: "left", label: "next" }],
  images: [{ id: id("i"), x: 0, y: 400, w: 200, h: 100, z: 0, ref }],
  inks: [{ id: id("k"), z: 0, color: "#ffffff", width: 2, points: [{ x: 10, y: 10 }, { x: 40, y: 30 }, { x: 70, y: 15 }] }],
};

describe("pad and excalidraw scene", () => {
  it("draws every kind the pad holds and reads the same pad back", () => {
    const scene = padToScene(pad, pal);
    expect(scene.map((e) => e.type).sort()).toEqual(
      ["arrow", "ellipse", "embeddable", "freedraw", "image", "line", "rectangle", "text", "text", "text"].sort(),
    );
    const read = sceneToPad(pad, scene, pal);
    expect(read.unsaved).toEqual([]);
    expect(read.unstored).toEqual([]);
    const sortById = (p: Pad) => ({
      ...p,
      shapes: [...p.shapes].sort((x, y) => x.id.localeCompare(y.id)),
    });
    expect(sortById(read.pad)).toEqual(sortById(pad));
    expect(padDiff(pad, read.pad)).toEqual([]);
  });

  it("turns an operator's moves, new ink and a deleted shape into patches the pad takes", () => {
    const scene = padToScene(pad, pal).map((element): SceneElement => {
      if (element.id === "b") return { ...element, x: 340 };
      if (element.id === "c") return { ...element, isDeleted: true };
      return element;
    });
    scene.push({
      ...scene.find((e) => e.type === "freedraw")!,
      id: "k2",
      customData: undefined,
      strokeColor: "#ffffff",
    });
    const read = sceneToPad(pad, scene, pal);
    const patches = padDiff(pad, read.pad);
    expect(patches.map((p) => `${p.op}:${"id" in p ? p.id : p.layer}`)).toEqual(["delete:c", "upsert:shape", "upsert:ink"]);
    const next = applyPatches(pad, patches);
    expect(Result.isSuccess(next)).toBe(true);
    if (Result.isSuccess(next)) expect(next.success.inks.find((ink) => ink.id === "k2")?.z).toBe(1);
  });

  it("names what the pad cannot hold, and never writes it", () => {
    const scene = padToScene(emptyPad(), pal);
    const diamond = { ...padToScene(pad, pal).find((e) => e.id === "a")!, id: "z", type: "diamond", boundElements: null };
    const loose = { ...padToScene(pad, pal).find((e) => e.id === "e")!, id: "y", startBinding: null, boundElements: null };
    const read = sceneToPad(emptyPad(), [...scene, diamond, loose], pal);
    expect([...read.unsaved].sort()).toEqual(["y", "z"]);
    expect(padDiff(emptyPad(), read.pad)).toEqual([]);
  });

  it("drops an edge with its shape in one delete", () => {
    const scene = padToScene(pad, pal).map((e) => (e.id === "a" ? { ...e, isDeleted: true } : e));
    const patches = padDiff(pad, sceneToPad(pad, scene, pal).pad);
    expect(patches).toEqual([{ op: "delete", id: "a" }]);
    expect(Result.isSuccess(applyPatches(pad, patches))).toBe(true);
  });
});

describe("settle", () => {
  it("keeps the stored item for an element the operator did not touch", () => {
    const measured = sceneToPad(pad, padToScene(pad, pal).map((e) => (e.id === "d" ? { ...e, width: 61, height: 21 } : e)), pal).pad;
    expect(padDiff(pad, measured).length).toBe(1);
    expect(padDiff(pad, settle(pad, measured, new Set()))).toEqual([]);
    expect(padDiff(pad, settle(pad, measured, new Set(["d"]))).length).toBe(1);
  });
});
