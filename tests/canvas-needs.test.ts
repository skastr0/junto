/**
 * What only the canvas knows, as feed needs: one per node, the stoppage
 * first, each in its region and each with the time it truly began.
 */
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { feedCanvasNeeds } from "../src/shared/canvas-needs";
import { deriveExecutionGraph, executionGraphFromSnapshot } from "../src/shared/execution-graph";
import { buildOperatorFeed } from "../src/shared/operator-feed";
import { actorRefFixture, executionContextForDoc } from "./helpers/actor-ref-fixtures";

const CANVAS = "needs";
const NOW = Date.parse("2026-08-12T13:00:00.000Z");
const at = (minute: number): string => new Date(Date.UTC(2026, 7, 12, 12, minute)).toISOString();
const seatId = actorRefFixture("atlas", CANVAS).seatId;

const doc = {
  nodes: [
    { id: "ops", type: "group", label: "Ops", x: 0, y: 0, width: 800, height: 400 },
    {
      id: "atlas",
      type: "text",
      text: "Atlas",
      x: 40,
      y: 40,
      width: 200,
      height: 100,
      ether: { entity: { kind: "agent", name: "local:atlas" }, terminal: { harness: "claude" } },
    },
    {
      id: "board",
      type: "text",
      text: "Ship it",
      x: 400,
      y: 40,
      width: 240,
      height: 120,
      ether: {
        entity: { kind: "task" },
        host: "local",
        tasks: {
          items: [
            { id: "t-late", state: "input-required", claimedBy: seatId, history: [], stateSince: at(40) },
            { id: "t-first", state: "input-required", claimedBy: seatId, history: [], stateSince: at(5) },
          ],
        },
      },
    },
    {
      id: "asks",
      type: "text",
      text: "requests",
      x: 2000,
      y: 0,
      width: 240,
      height: 120,
      ether: {
        entity: { kind: "requests" },
        requests: { items: [{ id: "r1", state: "input-required", claimedBy: seatId, history: [], stateSince: at(20) }] },
      },
    },
  ],
  edges: [{ id: "e1", fromNode: "atlas", toNode: "board", ether: { verb: "contributes" } }],
} as unknown as CanvasDoc;

const nameOf = (node: CanvasDoc["nodes"][number]): string => (node.type === "text" ? node.text : node.id);
const graph = deriveExecutionGraph(doc, executionContextForDoc(doc, CANVAS));

describe("feedCanvasNeeds", () => {
  it("lists the stoppage, the seat it holds up and the sink that wants input, each since it truly began", () => {
    const needs = feedCanvasNeeds({ doc, graph, nameOf });
    expect(needs.map((need) => [need.itemId, need.kind, need.seat.name, need.text, need.region.label, need.since])).toEqual([
      ["stoppage:board", "blocked", "Ship it", "holding up 1 other", "Ops", Date.parse(at(5))],
      ["held:atlas", "blocked", "Atlas", "waiting on blocked work upstream", "Ops", Date.parse(at(5))],
      ["input:asks", "attention", "requests", "wants your input", "open field", Date.parse(at(20))],
    ]);
  });

  it("adds a seat that wants input for a live reason, at the time given, once per node", () => {
    const wantsInput = new Map([
      ["atlas", 123],
      ["ghost", 456],
    ]);
    const needs = feedCanvasNeeds({ doc, graph, nameOf, wantsInput });
    // Atlas is already listed as held; the stoppage wins the node.
    expect(needs.filter((need) => need.seat.nodeId === "atlas").map((need) => need.itemId)).toEqual(["held:atlas"]);
    expect(needs.find((need) => need.itemId === "input:ghost")).toMatchObject({ kind: "attention", since: 456 });
  });

  it("counts the same from the kernel's snapshot (the companion) as from the graph (the desktop)", () => {
    // The record form the kernel cycle sends and the companion backend reads.
    const snapshot = {
      phaseByEdgeId: Object.fromEntries(graph.phaseByEdgeId),
      detailByEdgeId: Object.fromEntries(graph.detailByEdgeId),
      blocked: [...graph.blocked],
      blockedEdgeIds: [...graph.blockedEdgeIds],
      reasonsByNodeId: Object.fromEntries(graph.reasonsByNodeId),
    };
    const wire = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const fromSnapshot = feedCanvasNeeds({ doc, graph: executionGraphFromSnapshot(doc, wire), nameOf });
    const fromGraph = feedCanvasNeeds({ doc, graph, nameOf });
    expect(fromSnapshot).toEqual(fromGraph);
    const feedOf = (canvasNeeds: typeof fromGraph) =>
      buildOperatorFeed({ canvasName: CANVAS, nowMs: NOW, seats: [], signals: [], canvasNeeds });
    expect(feedOf(fromSnapshot).count).toBe(3);
    expect(feedOf(fromSnapshot)).toEqual(feedOf(fromGraph));
  });

  it("never makes up a time: a need whose start is unknown carries none and follows the dated ones", () => {
    const needs = feedCanvasNeeds({ doc, graph, nameOf, wantsInput: new Map([["ghost", undefined]]) });
    const ghost = needs.find((need) => need.itemId === "input:ghost");
    expect(ghost).toBeDefined();
    expect(ghost && "since" in ghost).toBe(false);

    const feed = buildOperatorFeed({ canvasName: CANVAS, nowMs: NOW, seats: [], signals: [], canvasNeeds: needs });
    const item = feed.sections.flatMap((section) => section.items).find((entry) => entry.itemId === "input:ghost");
    expect(item && ("since" in item || "ageMs" in item)).toBe(false);
    // Same urgency as the dated sink: the dated row leads, the undated one follows.
    const attention = feed.sections.flatMap((section) => section.items).filter((entry) => entry.kind === "attention");
    expect(attention.map((entry) => entry.itemId)).toEqual(["input:asks", "input:ghost"]);
    expect(feed.count).toBe(4);
  });

  it("a document that is not the work projection gives stops with no time, not now", () => {
    const unstamped = JSON.parse(JSON.stringify(doc).replaceAll(/,"stateSince":"[^"]+"/g, "")) as CanvasDoc;
    const needs = feedCanvasNeeds({
      doc: unstamped,
      graph: deriveExecutionGraph(unstamped, executionContextForDoc(unstamped, CANVAS)),
      nameOf,
    });
    expect(needs.map((need) => [need.itemId, need.since])).toEqual([
      ["stoppage:board", undefined],
      ["held:atlas", undefined],
      ["input:asks", undefined],
    ]);
  });

  it("is empty when nothing is stopped and no sink waits", () => {
    const calm = { nodes: doc.nodes.filter((node) => node.id === "ops" || node.id === "atlas"), edges: [] } as CanvasDoc;
    expect(feedCanvasNeeds({ doc: calm, graph: deriveExecutionGraph(calm, executionContextForDoc(calm, CANVAS)), nameOf })).toEqual([]);
  });
});
