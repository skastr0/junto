import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  PadPatch,
  applyPatches,
  asPadElementId,
  asPadPostId,
  emptyPad,
  type Pad,
  type PadError,
  type PadShape,
} from "../src/shared/pad";
import { contentBounds, identityCamera, viewToScene } from "../src/shared/pad-geom";
import {
  appendInkPoint,
  canDelete,
  cycleSelection,
  dataTransferHasImage,
  DEFAULT_IMAGE_SIZE,
  draftImageRect,
  applyMentionPick,
  draftPinFromDrag,
  draftShapeFromDrag,
  editorKeyAction,
  filterMentionActors,
  fitCamera,
  handleHit,
  inversePatches,
  mentionQueryAt,
  nearestSide,
  normalizeRect,
  padIsEmpty,
  panBy,
  pinReplyPatch,
  resizeShape,
  sideHit,
  toggleMention,
  toolFromKey,
  upsertPinPatch,
  upsertShapePatch,
  zoomAt,
} from "../src/renderer/components/pad/pad-editor-model";

const decodePatch = (patch: unknown): PadPatch =>
  Schema.decodeUnknownSync(PadPatch)(patch);

const expectOk = (result: Result.Result<Pad, PadError>): Pad => {
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

const box = (id: string, over: Record<string, unknown> = {}): PadShape => ({
  id: asPadElementId(id),
  type: "box",
  x: 0,
  y: 0,
  w: 40,
  h: 20,
  z: 0,
  ...over,
});

describe("pad editor tools", () => {
  it("maps v r o t l p i d", () => {
    expect(toolFromKey("v")).toBe("select");
    expect(toolFromKey("r")).toBe("box");
    expect(toolFromKey("o")).toBe("ellipse");
    expect(toolFromKey("t")).toBe("triangle");
    expect(toolFromKey("l")).toBe("label");
    expect(toolFromKey("p")).toBe("pin");
    expect(toolFromKey("i")).toBe("image");
    expect(toolFromKey("d")).toBe("ink");
  });

  it("reads editor keys and ignores typing", () => {
    expect(
      editorKeyAction({ key: "r", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "tool", tool: "box" });
    expect(
      editorKeyAction({ key: "p", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "tool", tool: "pin" });
    expect(
      editorKeyAction({ key: "i", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "tool", tool: "image" });
    expect(
      editorKeyAction({ key: "d", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "tool", tool: "ink" });
    expect(
      editorKeyAction({ key: "r", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: true }),
    ).toBeUndefined();
    expect(
      editorKeyAction({ key: "z", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "undo" });
    expect(
      editorKeyAction({ key: "[", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "z", delta: -1 });
    expect(
      editorKeyAction({ key: "]", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "z", delta: 1 });
    expect(
      editorKeyAction({ key: "Delete", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null }, { typing: false }),
    ).toEqual({ type: "delete" });
    expect(
      editorKeyAction({ key: "ArrowRight", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, target: null }, { typing: false }),
    ).toEqual({ type: "nudge", dx: 10, dy: 0 });
  });
});

describe("pad editor geometry", () => {
  it("normalizes flipped drags to a positive AABB", () => {
    expect(normalizeRect(20, 20, 4, 6)).toEqual({ x: 4, y: 6, w: 16, h: 14 });
  });

  it("drafts the four shape tools", () => {
    const boxDraft = draftShapeFromDrag("box", { x: 0, y: 0 }, { x: 30, y: 16 }, "s1" as never, 2);
    expect(boxDraft).toMatchObject({ type: "box", x: 0, y: 0, w: 30, h: 16, z: 2 });
    expect(draftShapeFromDrag("ellipse", { x: 0, y: 0 }, { x: 10, y: 10 }, "s2" as never, 0).type).toBe("ellipse");
    expect(draftShapeFromDrag("triangle", { x: 0, y: 0 }, { x: 10, y: 10 }, "s3" as never, 0).type).toBe("triangle");
    expect(draftShapeFromDrag("label", { x: 0, y: 0 }, { x: 10, y: 10 }, "s4" as never, 0)).toMatchObject({
      type: "label",
      text: "Label",
    });
  });

  it("hits the four AABB handles and the nearest side", () => {
    const shape = box("a", { x: 10, y: 10, w: 40, h: 20 });
    expect(handleHit(shape, { x: 10, y: 10 }, 4)).toBe("nw");
    expect(handleHit(shape, { x: 50, y: 30 }, 4)).toBe("se");
    expect(handleHit(shape, { x: 30, y: 20 }, 4)).toBeUndefined();
    expect(nearestSide(shape, { x: 30, y: 9 })).toBe("top");
    expect(sideHit(shape, { x: 30, y: 10 }, 3)).toBe("top");
    expect(sideHit(shape, { x: 30, y: 20 }, 2)).toBeUndefined();
  });

  it("resizes from a handle without flipping under min size", () => {
    const next = resizeShape(box("a", { x: 0, y: 0, w: 40, h: 20 }), "se", { x: 12, y: 4 });
    expect(next.w).toBeGreaterThanOrEqual(8);
    expect(next.h).toBeGreaterThanOrEqual(8);
  });

  it("zooms about the cursor and pans in view space", () => {
    const camera = identityCamera;
    const view = { x: 100, y: 50 };
    const sceneBefore = viewToScene(camera, view);
    const zoomed = zoomAt(camera, view, 2);
    expect(viewToScene(zoomed, view)).toEqual(sceneBefore);
    const panned = panBy(camera, 20, 0);
    expect(panned.x).toBe(-20);
  });

  it("fits content into the viewport", () => {
    const camera = fitCamera({ x: 0, y: 0, w: 200, h: 100 }, { w: 400, h: 300 }, 0);
    expect(camera.zoom).toBe(2);
    expect(camera.x).toBeCloseTo(-0);
    expect(camera.y).toBeCloseTo(-25);
  });
});

describe("pad editor inverse patches", () => {
  it("undoes a create by deleting", () => {
    const start = emptyPad();
    const patches: PadPatch[] = [upsertShapePatch(box("a"))];
    const inverse = inversePatches(start, patches);
    expect(Result.isSuccess(inverse)).toBe(true);
    if (Result.isFailure(inverse)) return;
    const after = expectOk(applyPatches(start, patches));
    const undone = expectOk(applyPatches(after, inverse.success));
    expect(undone.shapes).toEqual([]);
    expect(undone.revision).toBeGreaterThan(start.revision);
  });

  it("restores a deleted shape and its edges", () => {
    const start = expectOk(
      applyPatches(emptyPad(), [
        upsertShapePatch(box("a")),
        upsertShapePatch(box("b", { x: 80 })),
        decodePatch({
          op: "upsert",
          layer: "edge",
          edge: { id: "e1", from: "a", to: "b", fromSide: "right", toSide: "left" },
        }),
      ]),
    );
    const patches: PadPatch[] = [decodePatch({ op: "delete", id: "a" })];
    const inverse = inversePatches(start, patches);
    expect(Result.isSuccess(inverse)).toBe(true);
    if (Result.isFailure(inverse)) return;
    const after = expectOk(applyPatches(start, patches));
    expect(after.shapes.map((s) => s.id)).toEqual(["b"]);
    expect(after.edges).toEqual([]);
    const undone = expectOk(applyPatches(after, inverse.success));
    expect(undone.shapes.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(undone.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("undoes a move by upserting the previous AABB", () => {
    const start = expectOk(applyPatches(emptyPad(), [upsertShapePatch(box("a"))]));
    const moved = { ...box("a"), x: 15, y: 9 };
    const patches: PadPatch[] = [upsertShapePatch(moved)];
    const inverse = inversePatches(start, patches);
    expect(Result.isSuccess(inverse)).toBe(true);
    if (Result.isFailure(inverse)) return;
    const after = expectOk(applyPatches(start, patches));
    const undone = expectOk(applyPatches(after, inverse.success));
    expect(undone.shapes[0]).toMatchObject({ x: 0, y: 0, w: 40, h: 20 });
  });

  it("undoes an image upsert without introducing bytes", () => {
    const start = emptyPad();
    const patches: PadPatch[] = [
      decodePatch({
        op: "upsert",
        layer: "image",
        image: {
          id: "img1",
          x: 0,
          y: 0,
          w: 40,
          h: 30,
          z: 0,
          ref: {
            sha256: "a".repeat(64),
            byteLength: 4,
            mediaType: "image/png",
          },
        },
      }),
    ];
    const after = expectOk(applyPatches(start, patches));
    expect(JSON.stringify(after)).not.toMatch(/bytesBase64|data:image|base64,/);
    const inverse = inversePatches(start, patches);
    expect(Result.isSuccess(inverse)).toBe(true);
    if (Result.isFailure(inverse)) return;
    const undone = expectOk(applyPatches(after, inverse.success));
    expect(undone.images).toEqual([]);
  });
});

describe("pad editor selection", () => {
  it("cycles shapes then edges", () => {
    const pad = expectOk(
      applyPatches(emptyPad(), [
        upsertShapePatch(box("a", { z: 1 })),
        upsertShapePatch(box("b", { x: 80, z: 0 })),
        decodePatch({
          op: "upsert",
          layer: "edge",
          edge: { id: "e1", from: "a", to: "b" },
        }),
      ]),
    );
    expect(cycleSelection(pad, undefined, 1)).toBe("b");
    expect(cycleSelection(pad, "b", 1)).toBe("a");
    expect(cycleSelection(pad, "a", 1)).toBe("e1");
    expect(canDelete("shape")).toBe(true);
    expect(canDelete("pin")).toBe(true);
    expect(canDelete("ink")).toBe(true);
    expect(canDelete("image")).toBe(true);
    expect(contentBounds(pad).w).toBeGreaterThan(0);
  });
});

describe("pad editor pin ink empty", () => {
  it("defaults a click image rect and detects image paste flavors", () => {
    expect(draftImageRect({ x: 4, y: 6 }, { x: 5, y: 6 })).toEqual({
      x: 4,
      y: 6,
      w: DEFAULT_IMAGE_SIZE.w,
      h: DEFAULT_IMAGE_SIZE.h,
    });
    expect(draftImageRect({ x: 0, y: 0 }, { x: 80, y: 40 })).toEqual({
      x: 0,
      y: 0,
      w: 80,
      h: 40,
    });
    expect(dataTransferHasImage(null)).toBe(false);
    expect(dataTransferHasImage({ types: ["text/plain"] })).toBe(false);
    expect(dataTransferHasImage({ types: ["image/png"] })).toBe(true);
    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", {
      type: "image/png",
    });
    expect(dataTransferHasImage({ files: [file] })).toBe(true);
  });

  it("treats pin-only and ink-only pads as not empty", () => {
    expect(padIsEmpty(emptyPad())).toBe(true);
    const pinned = expectOk(
      applyPatches(emptyPad(), [
        upsertPinPatch({ id: asPadElementId("p1"), x: 12, y: 8, mentions: [] }),
      ]),
    );
    expect(padIsEmpty(pinned)).toBe(false);
    expect(pinned.pins).toHaveLength(1);
    const inked = expectOk(
      applyPatches(emptyPad(), [
        decodePatch({
          op: "upsert",
          layer: "ink",
          ink: {
            id: "k1",
            z: 0,
            color: "#d8d2c4",
            width: 2,
            points: [
              { x: 0, y: 0 },
              { x: 8, y: 4 },
            ],
          },
        }),
      ]),
    );
    expect(padIsEmpty(inked)).toBe(false);
  });

  it("places a click pin and a dragged look-here pin", () => {
    const click = draftPinFromDrag(asPadElementId("p1"), { x: 10, y: 10 }, { x: 11, y: 10 });
    expect(click).toMatchObject({ x: 10, y: 10, mentions: [] });
    expect(click.bounds).toBeUndefined();
    const dragged = draftPinFromDrag(asPadElementId("p2"), { x: 0, y: 0 }, { x: 40, y: 20 });
    expect(dragged).toMatchObject({ x: 20, y: 10, bounds: { w: 40, h: 20 } });
  });

  it("records ink points without collapsing a stroke", () => {
    const points = appendInkPoint([{ x: 0, y: 0 }], { x: 4, y: 3 });
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 3 },
    ]);
    expect(appendInkPoint(points, { x: 4.2, y: 3.1 }, 1)).toEqual(points);
  });

  it("filters @ autocomplete to inbound actors and builds a reply", () => {
    const actors = [
      { nodeId: "agent-in", label: "In", agentKey: "local:in" },
      { nodeId: "agent-quiet", label: "Quiet" },
    ];
    expect(filterMentionActors(actors, "in").map((actor) => actor.nodeId)).toEqual(
      ["agent-in"],
    );
    expect(filterMentionActors(actors, "ghost")).toEqual([]);
    expect(mentionQueryAt("see @ag", 7)).toEqual({ start: 4, query: "ag" });
    expect(mentionQueryAt("see you", 7)).toBeUndefined();
    const picked = applyMentionPick("see @ag", 7, "In Seat");
    expect(picked).toEqual({ text: "see @In-Seat ", cursor: 13 });
    expect(toggleMention(["agent-in"], "agent-quiet")).toEqual([
      "agent-in",
      "agent-quiet",
    ]);
    const reply = pinReplyPatch(
      asPadElementId("p1"),
      "look here",
      asPadPostId("post-1"),
    );
    expect(reply).toMatchObject({
      op: "pin.reply",
      pinId: "p1",
      post: { parts: [{ kind: "text", text: "look here" }] },
    });
  });
});
