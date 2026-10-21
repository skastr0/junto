import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { reachTargetCandidates, resolveWorkTarget } from "../src/main/junto/work/authz";
import { artifacts, canvasOf, region, seat, taskBoard, wire } from "./support/model-nodes";

// Region A holds the caller, board-a and the shared artifacts; region B holds board-b.
const canvas = canvasOf(
  [
    region("a", { x: 0, y: 0, width: 1000, height: 400 }, { label: "A" }),
    region("b", { x: 0, y: 600, width: 1000, height: 400 }, { label: "B" }),
    seat("caller", { x: 20, y: 20, width: 100, height: 50 }),
    seat("peer", { x: 200, y: 20, width: 100, height: 50, label: "reviewer" }),
    taskBoard("board-a", { x: 400, y: 20, width: 100, height: 50, name: "Backlog" }),
    artifacts("docs", { x: 600, y: 20, width: 100, height: 50, label: "Docs" }),
    taskBoard("board-b", { x: 400, y: 620, width: 100, height: 50, name: "Other" }),
  ],
  [wire("caller-peer", "caller", "peer", "messages")],
);

describe("resolveWorkTarget", () => {
  it("names resource nodes in the caller's region reach, and nothing outside it", () => {
    expect(reachTargetCandidates(canvas, "caller", "msg.send").map((c) => [c.kind, c.nodeId, c.name])).toEqual([
      ["task", "board-a", "Backlog"],
      ["artifacts", "docs", "Docs"],
    ]);
  });

  it("resolves a resource by name through reach, and mail by the wired seats", () => {
    const board = resolveWorkTarget(canvas, "caller", "backlog", "msg.send", reachTargetCandidates);
    expect(Result.isSuccess(board) && board.success).toEqual({ nodeId: "board-a" });
    const mail = resolveWorkTarget(canvas, "caller", "Reviewer", "msg.send");
    expect(Result.isSuccess(mail) && mail.success).toEqual({ nodeId: "peer" });
  });

  it("refuses a name outside reach with every candidate, typed", () => {
    const refused = resolveWorkTarget(canvas, "caller", "Other", "msg.send", reachTargetCandidates);
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      type: "UnknownTarget",
      details: {
        target: "Other",
        candidates: [
          { kind: "task", nodeId: "board-a", name: "Backlog" },
          { kind: "artifacts", nodeId: "docs", name: "Docs" },
        ],
      },
    });
  });

  it("refuses a malformed ref without treating it as a name", () => {
    const refused = resolveWorkTarget(canvas, "caller", "junto://canvas/factory?node=", "msg.send", reachTargetCandidates);
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({ type: "InputError", details: { path: "target" } });
  });
});
