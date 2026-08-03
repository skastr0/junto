import { EdgeBoardNotifyToggle, SeedState } from "@skastr0/vellum";

// EdgeBoardNotifyToggle takes an `edge` prop directly, but resolves its
// endpoint NODES from the app's global doc store (`use$(state$.doc)`) to
// decide whether either side is a board. SeedState seeds a doc whose nodes
// match the edge's fromNode/toNode ids so `touchesBoard` actually resolves.
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
      text: "Ops Agent",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: { entity: { kind: "agent" } },
    },
    {
      id: "board-1",
      type: "text" as const,
      text: "Team Board",
      x: 260,
      y: 0,
      width: 200,
      height: 80,
      ether: { entity: { kind: "board" } },
    },
  ],
  edges: [],
};

// Absent ether.notify — default ON when connected to a board (product law).
export const NotifyOn = () => (
  <SeedState doc={doc}>
    <Frame>
      <EdgeBoardNotifyToggle edge={{ id: "e-notify-on", fromNode: "agent-1", toNode: "board-1" }} />
    </Frame>
  </SeedState>
);

// Explicit ether.notify: false — operator opted this seat out of the megaphone.
export const NotifyOff = () => (
  <SeedState doc={doc}>
    <Frame>
      <EdgeBoardNotifyToggle
        edge={{ id: "e-notify-off", fromNode: "agent-1", toNode: "board-1", ether: { notify: false } }}
      />
    </Frame>
  </SeedState>
);
