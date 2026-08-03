import { EdgePortsAttenuator } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

// Nests EdgeBoardNotifyToggle / EdgeRelayStateToggle, which read the app's
// global doc store and always render null in this harness (empty doc) — only
// the "limit this key" allow-list section below is prop-driven and visible.
export const FullDefault = () => (
  <Frame>
    <EdgePortsAttenuator edge={{ id: "e1", fromNode: "agent-1", toNode: "task-1" }} />
  </Frame>
);

export const ExplicitAllowlist = () => (
  <Frame>
    <EdgePortsAttenuator
      edge={{
        id: "e2",
        fromNode: "agent-2",
        toNode: "task-2",
        ether: { ports: ["msg.send", "tasks.claim"] },
      }}
    />
  </Frame>
);
