import { EdgeCommandCard, SeedState } from "@skastr0/vellum";

// EdgeCommandCard resolves edgeId against the app's global doc + kernel
// execution stores (`if (!edge) return null`). SeedState seeds both so the
// real command — relation card renders — idle (soft relates) and live
// (kernel-reported "blocks" phase) are genuinely different visual states.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, width: 440 }}>{children}</div>
);

// No criteria, no kernel execution seeded — the card's cold idle look.
export const SoftRelates = () => (
  <SeedState
    doc={{
      nodes: [
        {
          id: "agent-1",
          type: "text",
          text: "Release Agent",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent" } },
        },
        {
          id: "task-1",
          type: "text",
          text: "Ship checklist",
          x: 260,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [{ id: "e-relates", fromNode: "agent-1", toNode: "task-1" }],
    }}
  >
    <Frame>
      <EdgeCommandCard edgeId="e-relates" />
    </Frame>
  </SeedState>
);

// Criteria "tasks" + a live kernel snapshot reporting the edge as blocking —
// crimson "blocks" signal, the real stoppage detail line.
export const LiveBlocks = () => (
  <SeedState
    doc={{
      nodes: [
        {
          id: "task-1",
          type: "text",
          text: "Ship checklist",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "task" } },
        },
        {
          id: "agent-2",
          type: "text",
          text: "Release Agent",
          x: 260,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent" } },
        },
      ],
      edges: [
        {
          id: "e-blocks",
          fromNode: "task-1",
          toNode: "agent-2",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    }}
    execution={{
      phaseByEdgeId: { "e-blocks": "blocks" },
      detailByEdgeId: { "e-blocks": "needs input" },
      blocked: ["agent-2"],
      blockedEdgeIds: ["e-blocks"],
      reasonsByNodeId: {
        "agent-2": [{ kind: "edge", edgeId: "e-blocks", fromNodeId: "task-1", detail: "needs input" }],
      },
    }}
  >
    <Frame>
      <EdgeCommandCard edgeId="e-blocks" />
    </Frame>
  </SeedState>
);
