import { EdgeRelayStateToggle, SeedState } from "@skastr0/vellum";

// EdgeRelayStateToggle takes an `edge` prop directly, but resolves both
// endpoints from the app's global doc store to confirm they are both actors
// before showing anything. SeedState seeds a doc whose nodes match the
// edge's fromNode/toNode ids so `fromActor`/`toActor` both resolve true.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const doc = {
  nodes: [
    {
      id: "agent-1",
      type: "text" as const,
      text: "Build Agent",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: { entity: { kind: "agent" } },
    },
    {
      id: "agent-2",
      type: "text" as const,
      text: "QA Agent",
      x: 260,
      y: 0,
      width: 200,
      height: 80,
      ether: { entity: { kind: "agent" } },
    },
  ],
  edges: [],
};

// Opt-in relay ON — a blocked endpoint relays its stoppage to the other.
export const RelayOn = () => (
  <SeedState doc={doc}>
    <Frame>
      <EdgeRelayStateToggle
        edge={{ id: "e-relay-on", fromNode: "agent-1", toNode: "agent-2", ether: { relayState: true } }}
      />
    </Frame>
  </SeedState>
);

// Default OFF — absent ether.relayState.
export const RelayOff = () => (
  <SeedState doc={doc}>
    <Frame>
      <EdgeRelayStateToggle edge={{ id: "e-relay-off", fromNode: "agent-1", toNode: "agent-2" }} />
    </Frame>
  </SeedState>
);
