/**
 * A card on the pad: what a paste, a drop or an @ pick makes. One shape
 * upsert at the default box, centred where it landed, on top, that the pad
 * rules like any shape; a web link or plain text makes nothing.
 */
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { formatNodeRef } from "../src/shared/node-ref";
import { applyPatch, decodePadShape, emptyPad, type Pad } from "../src/shared/pad";
import type { NodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import { padCardFor, padCardSourceOfPick, padCardSourceOfText } from "../src/renderer/components/pad/pad-card";
import { pickCandidates } from "../src/renderer/components/pad/PadCardPicker";
import type { MentionCandidate } from "../src/renderer/lib/mention-draft";

const SEAT = "agent-01M46TX8WR2Q4YGKZ6NFW4GTG8" as NodeId;
const BOARD = "task-01M5G1KYYMFQASGJKGBDQZA2D3" as NodeId;
const ITEM = "01M5Y9Q544EFBXQMPY7WCNVWMT" as ItemId;
const seatHref = formatNodeRef({ canvasName: "factory", nodeId: SEAT });
const taskHref = `${formatNodeRef({ canvasName: "factory", nodeId: BOARD })}&item=${ITEM}`;

describe("padCardSourceOfText", () => {
  it("reads a bare ref, a mention link and an embed; the label drops a seat's @ and keeps a task's number", () => {
    expect(padCardSourceOfText(seatHref)).toEqual({ href: seatHref, label: seatHref });
    expect(padCardSourceOfText(`[@planner](${seatHref})`)).toEqual({ href: seatHref, label: "planner" });
    expect(padCardSourceOfText(`![#42 Fix tabs](${taskHref})`)).toEqual({ href: taskHref, label: "#42 Fix tabs" });
  });

  it("a web link or plain text makes no card", () => {
    expect(padCardSourceOfText("https://example.com")).toBeUndefined();
    expect(padCardSourceOfText("ship it")).toBeUndefined();
  });

  it("a long label is cut to the shape's limit on one line", () => {
    const label = padCardSourceOfText(`[${"a ".repeat(300)}](${seatHref})`)!.label;
    expect(label.length).toBe(200);
    expect(label).not.toContain("  ");
  });
});

describe("padCardSourceOfPick", () => {
  it("names the picked thing on this canvas", () => {
    expect(padCardSourceOfPick({ ref: { kind: "task", nodeId: BOARD, taskId: ITEM }, label: "#42 Fix tabs" }, "factory")).toEqual({ href: taskHref, label: "#42 Fix tabs" });
    expect(padCardSourceOfPick({ ref: { kind: "seat", nodeId: SEAT }, label: "@planner" }, "factory")).toEqual({ href: seatHref, label: "planner" });
  });
});

describe("padCardFor", () => {
  const pad: Pad = { ...emptyPad(), shapes: [{ id: "box-1" as never, type: "box", x: 0, y: 0, w: 40, h: 40, z: 4 }] };

  it("is one shape upsert at the default box, centred on the point, above every shape", () => {
    const { shape, patch } = padCardFor({ href: seatHref, label: "planner" }, { x: 500, y: 300 }, pad, () => "a");
    expect(shape).toEqual({ id: "card-a", type: "card", x: 356, y: 264, w: 288, h: 72, z: 5, href: seatHref, label: "planner" });
    expect(patch).toEqual({ op: "upsert", layer: "shape", shape });
  });

  it("decodes as a pad shape and the pad rules it, so an edge can bind it", () => {
    const { shape, patch } = padCardFor({ href: taskHref, label: "#42 Fix tabs" }, { x: 0, y: 0 }, pad, () => "b");
    expect(Result.isSuccess(decodePadShape(shape))).toBe(true);
    const next = applyPatch(pad, patch);
    expect(Result.isSuccess(next)).toBe(true);
    const bound = applyPatch(Result.getOrThrow(next), { op: "upsert", layer: "edge", edge: { id: "edge-1" as never, from: "box-1" as never, to: shape.id } });
    expect(Result.isSuccess(bound)).toBe(true);
  });
});

describe("pickCandidates", () => {
  const candidates: ReadonlyArray<MentionCandidate> = [
    { ref: { kind: "seat", nodeId: SEAT }, label: "@planner" },
    { ref: { kind: "task", nodeId: BOARD, taskId: ITEM }, label: "#42 Plan the tabs" },
    { ref: { kind: "seat", nodeId: "agent-x" as NodeId }, label: "@builder" },
  ];

  it("keeps every kind, names that start with the query first", () => {
    expect(pickCandidates(candidates, "pla").map((c) => c.label)).toEqual(["@planner", "#42 Plan the tabs"]);
    expect(pickCandidates(candidates, "@b").map((c) => c.label)).toEqual(["@builder"]);
    expect(pickCandidates(candidates, "tabs").map((c) => c.label)).toEqual(["#42 Plan the tabs"]);
    expect(pickCandidates(candidates, "  ")).toBe(candidates);
  });
});
