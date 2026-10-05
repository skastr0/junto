/**
 * The top-right inbox list: every feed item, plus what only the canvas
 * knows where the feed has nothing as urgent, newest first.
 */
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { FeedItem } from "../src/shared/operator-feed";
import { canvasNeeds, needsYouEntries } from "../src/renderer/lib/needs-you-inbox";

const feedItem = (nodeId: string, kind: FeedItem["kind"], since: number): FeedItem => ({
  itemId: `${kind}:${nodeId}`,
  kind,
  urgency: 1,
  canvasName: "main",
  seat: { nodeId, name: nodeId, portraitIdentity: nodeId },
  region: { regionId: null, label: "open field", path: [] },
  text: `${nodeId} says`,
  since,
  ageMs: 0,
});

const doc = {
  nodes: [
    { id: "task", type: "text", text: "Ship it", x: 0, y: 0, width: 10, height: 10 },
    { id: "atlas", type: "text", text: "Atlas", x: 0, y: 0, width: 10, height: 10 },
  ],
  edges: [],
} as unknown as CanvasDoc;

describe("needs-you inbox", () => {
  it("lists newest first, keeps every feed item, and adds a canvas need only when it is more urgent", () => {
    const canvas = canvasNeeds({
      doc,
      stoppages: [{ seedNodeId: "task", seedBrief: "1 task", stops: 3, attentionLeadIds: [], clearAction: "", cone: {} as never }],
      graphBlocked: new Set(["task", "atlas"]),
      needsInput: new Set(["atlas", "gone"]),
    });
    expect(canvas.map((need) => [need.nodeId, need.kind, need.text])).toEqual([
      ["task", "blocked", "holding up 2 others"],
      ["atlas", "blocked", "waiting on blocked work upstream"],
      ["gone", "needs_input", "wants your input"],
    ]);

    const seen = new Map([["stoppage:task", 50], ["held:atlas", 10], ["input:gone", 5]]);
    const entries = needsYouEntries(
      [
        feedItem("atlas", "health", 40),
        feedItem("pixel", "feedback", 30),
        feedItem("nova", "attention", 60),
        { ...feedItem("nova", "escalate", 20), itemId: "escalate:nova:2" },
        feedItem("gone", "attention", 1),
      ],
      canvas,
      (id) => seen.get(id) ?? 0,
    );
    expect(entries.map((entry) => [entry.nodeId, entry.kind])).toEqual([
      ["nova", "needs_input"],
      ["task", "blocked"],
      ["atlas", "waiting"],
      ["pixel", "review"],
      ["nova", "escalation"],
      ["atlas", "blocked"],
      ["gone", "needs_input"],
    ]);
  });
});
