import { SeedState, StoppageRank } from "@skastr0/vellum";

// StoppageRank takes no props — it ranks blast-radius stoppage seeds from the
// app's global doc + kernel execution stores (`if (ranked.length === 0)
// return null`). SeedState seeds both with three distinct stoppage shapes so
// the real crimson-list look renders: a manual blocker flag (no edges
// needed), a "requests" sink with a pending input-required item blocking its
// actor, and a plain note generating a "blocks" edge into a different actor.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, width: 520 }}>{children}</div>
);

export const RankedStoppages = () => (
  <SeedState
    doc={{
      nodes: [
        {
          id: "agent-ops",
          type: "text",
          text: "Ops Agent",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent" }, flags: ["blocker"] },
        },
        {
          id: "requests-vendor",
          type: "text",
          text: "Vendor requests",
          x: 260,
          y: -160,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "requests" },
            requests: {
              items: [
                {
                  id: "req-1",
                  state: "input-required",
                  claimedBy: "agent-legal",
                  history: [
                    {
                      messageId: "m1",
                      role: "user",
                      parts: [{ kind: "text", text: "Approve vendor contract renewal?" }],
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          id: "agent-legal",
          type: "text",
          text: "Legal Agent",
          x: 520,
          y: -160,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent" } },
        },
        {
          id: "note-freeze",
          type: "text",
          text: "Code freeze window",
          x: 260,
          y: 160,
          width: 200,
          height: 80,
        },
        {
          id: "agent-build",
          type: "text",
          text: "Build Agent",
          x: 520,
          y: 160,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent" } },
        },
      ],
      edges: [
        { id: "e-vendor", fromNode: "requests-vendor", toNode: "agent-legal" },
        { id: "e-freeze", fromNode: "note-freeze", toNode: "agent-build" },
      ],
    }}
    execution={{
      phaseByEdgeId: { "e-vendor": "blocks", "e-freeze": "blocks" },
      detailByEdgeId: { "e-vendor": "awaiting approval", "e-freeze": "code freeze in effect" },
      blocked: ["agent-legal", "agent-build"],
      blockedEdgeIds: ["e-vendor", "e-freeze"],
      reasonsByNodeId: {
        "agent-legal": [
          { kind: "edge", edgeId: "e-vendor", fromNodeId: "requests-vendor", detail: "awaiting approval" },
        ],
        "agent-build": [
          { kind: "edge", edgeId: "e-freeze", fromNodeId: "note-freeze", detail: "code freeze in effect" },
        ],
      },
    }}
  >
    <Frame>
      <StoppageRank />
    </Frame>
  </SeedState>
);
