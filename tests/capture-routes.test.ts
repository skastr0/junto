/**
 * Q5 (docs/plans/0.11/11-quick-capture.md): where a capture's links,
 * mentions, labels and likeness point, as up to three Artifacts nodes.
 */
import { describe, expect, it } from "vitest";
import { captureRoutes, type RouteArtifact } from "../src/shared/capture-routes";
import { mentionHref, type MentionRef } from "../src/shared/mention";
import type { NodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import { artifacts, canvasOf, region, seat, taskBoard } from "./support/model-nodes";

const id = (n: number): ItemId => `01M639AA0000000000000000${String(n).padStart(2, "0")}` as ItemId;
const node = (name: string): NodeId => name as NodeId;
const link = (ref: MentionRef, label: string): string => `[${label}](${mentionHref(ref, "factory")})`;

// Inbox at the root; Research and Specs in region R with seat S and board T; Ops alone in region Q.
const board = canvasOf([
  region("R", { x: 0, y: 0, width: 1000, height: 1000 }),
  region("Q", { x: 2000, y: 0, width: 1000, height: 1000 }),
  artifacts("Inbox", { x: -800, y: 0 }),
  artifacts("Research", { x: 100, y: 100 }),
  artifacts("Specs", { x: 500, y: 100 }),
  seat("S", { x: 100, y: 600 }),
  taskBoard("T", { x: 500, y: 600 }),
  artifacts("Ops", { x: 2100, y: 100 }),
]);

const art = (n: number, nodeId: string, title: string, text = "", labels: ReadonlyArray<string> = [], archived = false): RouteArtifact => ({
  artifactId: id(n),
  nodeId: node(nodeId),
  title,
  text,
  labels,
  archived,
});

const capture = (text: string, labels: ReadonlyArray<string> = [], title = "Capture"): RouteArtifact => art(0, "Inbox", title, text, labels);

describe("capture routes", () => {
  it("suggests nothing when nothing points anywhere", () => {
    expect(captureRoutes(board, capture("hello"), [art(1, "Research", "Other", "unrelated words entirely")])).toEqual([]);
  });

  it("follows a link to the node its artifact is on now, not the node the link was written with", () => {
    const moved = art(1, "Ops", "Runbook");
    const text = `see ${link({ kind: "artifact", nodeId: node("Research"), artifactId: id(1) }, "Runbook")}`;
    const [first] = captureRoutes(board, capture(text), [moved]);
    expect(first?.nodeId).toBe("Ops");
    expect(first?.reasons[0]).toBe("links");
  });

  it("splits a seat mention over the Artifacts nodes in its reach, never the capture's own node", () => {
    const routes = captureRoutes(board, capture(`ask ${link({ kind: "seat", nodeId: node("S") }, "S")}`), []);
    expect(routes.map((route) => route.nodeId).sort()).toEqual(["Research", "Specs"]);
    expect(routes.every((route) => route.reasons[0] === "mentions")).toBe(true);
    expect(routes.some((route) => route.nodeId === "Inbox")).toBe(false);
  });

  it("weighs a label by where its artifacts are, and leaves archived ones out", () => {
    const routes = captureRoutes(board, capture("x", ["design"]), [
      art(1, "Specs", "A", "", ["design"]),
      art(2, "Specs", "B", "", ["design"]),
      art(3, "Research", "C", "", ["design"]),
      art(4, "Ops", "D", "", ["design"], true),
    ]);
    expect(routes.map((route) => route.nodeId)).toEqual(["Specs", "Research"]);
    expect(routes[0]!.score).toBeGreaterThan(routes[1]!.score);
  });

  it("points at the node holding the artifacts most like it in words", () => {
    const routes = captureRoutes(board, capture("Quarterly revenue forecast for the retail pipeline"), [
      art(1, "Ops", "Retail revenue forecast", "pipeline forecast by quarter, revenue targets"),
      art(2, "Research", "Bird migration", "swallows and terns over the estuary"),
    ]);
    expect(routes.map((route) => route.nodeId)).toEqual(["Ops"]);
    expect(routes[0]!.reasons).toEqual(["similar"]);
  });

  it("ranks a link above a likeness and gives at most three", () => {
    const text = `${link({ kind: "artifact", nodeId: node("Specs"), artifactId: id(1) }, "Spec")} quarterly revenue forecast ${link({ kind: "task", nodeId: node("T"), taskId: id(9) }, "#1 task")}`;
    const routes = captureRoutes(board, capture(text, ["ops"]), [
      art(1, "Specs", "Spec"),
      art(2, "Ops", "Revenue forecast", "quarterly revenue forecast", ["ops"]),
      art(3, "Research", "Forecast notes", "revenue forecast quarterly"),
    ]);
    expect(routes).toHaveLength(3);
    expect(routes[0]!.nodeId).toBe("Specs");
    expect(routes[0]!.reasons[0]).toBe("links");
  });

  it("never suggests a node that is not an Artifacts node on this canvas", () => {
    const text = link({ kind: "artifact", nodeId: node("Gone"), artifactId: id(7) }, "lost");
    expect(captureRoutes(board, capture(text), [])).toEqual([]);
  });
});
