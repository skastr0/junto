import { NodePlacementSection } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const node = (host?: string) => ({
  id: "node-1",
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  text: "research agent",
  ether: { entity: { kind: "agent" }, ...(host ? { host } : {}) },
});

export const Local = () => (
  <Frame>
    <NodePlacementSection node={node()} />
  </Frame>
);

export const RemoteStation = () => (
  <Frame>
    <NodePlacementSection node={node("remote-a")} />
  </Frame>
);
