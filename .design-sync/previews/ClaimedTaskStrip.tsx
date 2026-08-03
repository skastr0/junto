import { ClaimedTaskStrip } from "@skastr0/vellum";

// ClaimedTaskStrip reads the live claimed-task projection off app-global
// state$ (doc + actorRefs), not off props/context — it has no way to receive
// seed data from an isolated preview bundle (see learnings). It always
// renders null here, which is the SAME behavior a real idle/unclaimed seat
// shows in the app, so the empty render is truthful, not broken.

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "grid",
      gap: 10,
      maxWidth: 280,
    }}
  >
    {children}
  </div>
);

const MockSeatCard = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      border: "1px dashed rgba(237,230,218,0.22)",
      borderRadius: 10,
      padding: "10px 12px",
      background: "rgba(255,255,255,0.02)",
    }}
  >
    <div style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: "#EDE6DA" }}>
      claude:workshop — agent seat
    </div>
    {children}
  </div>
);

export const EmptyState = () => (
  <Frame>
    <MockSeatCard>
      <ClaimedTaskStrip
        node={{
          id: "agent-1",
          type: "text",
          text: "",
          x: 0,
          y: 0,
          width: 220,
          height: 120,
          ether: { entity: { kind: "agent", name: "claude:workshop" } },
        }}
      />
    </MockSeatCard>
    <div style={{ fontSize: 10, color: "#8a8378", lineHeight: 1.5 }}>
      Renders nothing here on purpose: the strip reads the claimed-task
      projection from live app state, which this isolated preview harness has
      no way to seed (no doc/actorRefs outside the running app). In the app,
      this line shows a colored dot plus the claimed task's brief the moment
      the seat picks up work.
    </div>
  </Frame>
);
