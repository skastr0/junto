import { describe, expect, it } from "vitest";
import { board, canvasOf, note, seat, wire } from "./support/model-nodes";
import {
  actorEdgePhaseLabel,
  actorEdgeRows,
} from "../src/renderer/lib/actor-edges";

const agent = (id: string, label: string) => seat(id, { label: label as never });

describe("actorEdgeRows", () => {
  it("returns empty for a node that is not a seat", () => {
    const canvas = canvasOf([note("m", "memo"), board("n")], []);
    expect(actorEdgeRows(canvas, "m")).toEqual([]);
    expect(actorEdgeRows(canvas, "missing")).toEqual([]);
  });

  it("lists directed incident wires with the peer's kind — no soft nature", () => {
    const canvas = canvasOf(
      [agent("worker", "Grok"), agent("lead", "Claude"), agent("helper", "Codex"), board("talk")],
      [
        wire("e-in", "lead", "worker", "messages"),
        wire("e-out", "worker", "helper", "messages"),
        wire("e-board", "worker", "talk", "participates"),
      ],
    );
    const rows = actorEdgeRows(canvas, "worker");
    expect(rows.map((r) => r.edgeId).sort()).toEqual(["e-board", "e-in", "e-out"]);

    const inRow = rows.find((r) => r.edgeId === "e-in")!;
    expect(inRow.direction).toBe("in");
    expect(inRow.peerKind).toBe("agent");
    expect(inRow.peerId).toBe("lead");
    expect(inRow.peerTitle).toBe("Claude");
    expect(inRow.boardNotify).toBeNull();
    expect(actorEdgePhaseLabel(inRow)).toBeNull();

    const outRow = rows.find((r) => r.edgeId === "e-out")!;
    expect(outRow.direction).toBe("out");
    expect(outRow.peerKind).toBe("agent");
    expect(outRow.peerId).toBe("helper");

    // A board the seat takes part in wakes it: the megaphone is on.
    const boardRow = rows.find((r) => r.edgeId === "e-board")!;
    expect(boardRow.direction).toBe("out");
    expect(boardRow.peerKind).toBe("board");
    expect(boardRow.boardNotify).toBe("on");
  });

  it("carries the kernel's live phase when the caller holds it", () => {
    const canvas = canvasOf([agent("worker", "Grok"), agent("lead", "Claude")], [wire("e", "lead", "worker", "messages")]);
    const row = actorEdgeRows(canvas, "worker", new Map([["e", "blocks" as const]]))[0]!;
    expect(actorEdgePhaseLabel(row)).toBe("blocks");
  });
});
