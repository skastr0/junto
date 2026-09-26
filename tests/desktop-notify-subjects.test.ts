import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { buildOperatorFeed, feedSeatsFromDoc } from "../src/shared/operator-feed";
import type { AgentSignal } from "../src/shared/agent-signals";
import { seatSubjects, subjectsFromFeed } from "../src/renderer/lib/desktop-notify";

const agent = (id: string, name: string): CanvasNode =>
  ({
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    text: name,
    ether: { entity: { kind: "agent", name: `local:${id}` } },
  }) as CanvasNode;

const doc: CanvasDoc = { nodes: [agent("a1", "Maple"), agent("a2", "Pip"), agent("a3", "Clove")], edges: [] } as CanvasDoc;

const signal = (nodeId: string, kind: AgentSignal["kind"], text: string): AgentSignal =>
  ({
    signalId: `s-${nodeId}`,
    canvasName: "main",
    nodeId,
    kind,
    text,
    state: "open",
    createdAt: 1,
  }) as AgentSignal;

describe("desktop notification subjects", () => {
  it("maps feed items to categories and leaves out the AI's reading", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: 10,
      seats: feedSeatsFromDoc(doc, {
        nameOf: (node) => (node.type === "text" ? node.text : node.id),
        attentionByNodeId: new Map([["a3", { reason: "permission dialog", at: 5 }]]),
        healthByNodeId: new Map(),
      }),
      signals: [signal("a1", "blocked", "cannot reach the database"), signal("a2", "escalate", "which region?")],
    });
    expect(
      subjectsFromFeed(feed).map((subject) => [subject.seatName, subject.category, subject.text]),
    ).toEqual([
      ["Maple", "blocked", "cannot reach the database"],
      ["Clove", "needsYou", "wants your input"],
      ["Pip", "needsYou", "which region?"],
    ]);
  });

  const base = {
    canvasName: "main",
    doc,
    bindingOf: (node: CanvasNode) => `b-${node.id}`,
    seatState: () => ({ state: "idle", at: 42 }),
    needsLook: () => false,
    failure: () => undefined,
    exitMessage: () => undefined,
    lastSaid: () => undefined,
  };

  it("names a finished, unread seat with its own last words", () => {
    const subjects = seatSubjects({
      ...base,
      needsLook: (bindingId) => bindingId === "b-a1",
      lastSaid: (nodeId) => (nodeId === "a1" ? "migrations are in, tests pass" : undefined),
    });
    expect(subjects).toEqual([
      {
        key: "done:a1:42",
        category: "done",
        canvasName: "main",
        nodeId: "a1",
        seatName: "Maple",
        text: "migrations are in, tests pass",
      },
    ]);
  });

  it("reports a failed seat by its exit, before anything else about it", () => {
    const subjects = seatSubjects({
      ...base,
      needsLook: () => true,
      failure: (bindingId) => (bindingId === "b-a2" ? { epoch: "e7", code: 1 } : undefined),
      exitMessage: (bindingId) => (bindingId === "b-a2" ? "claude exited: rate limited" : undefined),
    });
    const pip = subjects.filter((subject) => subject.nodeId === "a2");
    expect(pip).toEqual([expect.objectContaining({ key: "failed:a2:e7", category: "failed", text: "claude exited: rate limited" })]);
  });

  it("says nothing for a resting seat", () => {
    expect(seatSubjects(base)).toEqual([]);
  });
});
