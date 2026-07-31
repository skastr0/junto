import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { mergePortfolioInto } from "../src/shared/portfolio";

const hermesState = (agentKey: string): SnapshotState =>
  ({
    bundles: [
      {
        source: "hermes",
        ok: true,
        entities: [
          {
            kind: "agent",
            key: agentKey,
            title: agentKey,
            stats: { hostId: "local" },
          },
        ],
      },
    ],
  }) as unknown as SnapshotState;

describe("mergePortfolioInto entity suppress", () => {
  it("does not re-mint a suppressed agent entity id", () => {
    const doc: CanvasDoc = { nodes: [], edges: [] };
    const state = hermesState("local:worker");
    const id = "agent-local-worker";
    const suppressed = mergePortfolioInto(doc, state, {
      suppressEntityIds: new Set([id]),
    });
    expect(suppressed.nodes).toHaveLength(0);

    const allowed = mergePortfolioInto(doc, state, {
      suppressEntityIds: new Set(),
    });
    expect(allowed.nodes.map((n) => n.id)).toEqual([id]);
  });
});
