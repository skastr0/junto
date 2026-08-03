import { NodeFlagControls } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const node = (flags?: ReadonlyArray<string>) => ({
  id: "node-1",
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  text: "research agent",
  ...(flags ? { ether: { flags } } : {}),
});

export const NoFlags = () => (
  <Frame>
    <NodeFlagControls node={node()} />
  </Frame>
);

export const BlockerActive = () => (
  <Frame>
    <NodeFlagControls node={node(["blocker"])} />
  </Frame>
);
