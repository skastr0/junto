import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  linkSeatMentions,
  mailMentionCandidates,
  reachTargetCandidates,
  resolveWorkTarget,
  resourceMentionCandidates,
} from "../src/main/junto/work/authz";
import { mentionLink } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
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

describe("linkSeatMentions", () => {
  const link = (id: string, name: string) => mentionLink({ kind: "seat", nodeId: asNodeId(id) }, `@${name}`, "factory");

  it("offers mail the wired seats, and a resource's comments the seats in its reach", () => {
    expect(mailMentionCandidates(canvas, "caller").map((c) => c.nodeId)).toEqual(["peer"]);
    expect(resourceMentionCandidates(canvas, "docs").map((c) => c.nodeId)).toEqual(["caller", "peer"]);
    expect(resourceMentionCandidates(canvas, "board-b")).toEqual([]);
  });

  it("rewrites each @name to its seat's link with the seat's own name, by name or by id", () => {
    const linked = linkSeatMentions(canvas, "factory", "caller", "@REVIEWER and @peer, not ops@x.dev", mailMentionCandidates(canvas, "caller"));
    expect(linked).toEqual(Result.succeed(`${link("peer", "reviewer")} and ${link("peer", "reviewer")}, not ops@x.dev`));
  });

  it("refuses an unknown name UnknownTarget, naming the token and every seat it could mention", () => {
    const refused = linkSeatMentions(canvas, "factory", "caller", "hi @nobody", mailMentionCandidates(canvas, "caller"));
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      type: "UnknownTarget",
      details: { path: "text", target: "@nobody", candidates: [{ nodeId: "peer", name: "reviewer" }] },
    });
  });

  it("refuses the id of a node that is no seat it can mention", () => {
    const refused = linkSeatMentions(canvas, "factory", "caller", "@board-a", resourceMentionCandidates(canvas, "docs"));
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({ type: "UnknownTarget", details: { target: "@board-a" } });
  });

  it("refuses a name two seats share, listing both", () => {
    const twins = canvasOf([
      region("a", { x: 0, y: 0, width: 1000, height: 400 }, { label: "A" }),
      seat("caller", { x: 20, y: 20, width: 100, height: 50 }),
      seat("one", { x: 200, y: 20, width: 100, height: 50, label: "twin" }),
      seat("two", { x: 400, y: 20, width: 100, height: 50, label: "twin" }),
      artifacts("docs", { x: 600, y: 20, width: 100, height: 50, label: "Docs" }),
    ]);
    const refused = linkSeatMentions(twins, "factory", "caller", "@twin", resourceMentionCandidates(twins, "docs"));
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      type: "InputError",
      details: { target: "@twin", candidates: [{ nodeId: "one" }, { nodeId: "two" }] },
    });
  });
});
