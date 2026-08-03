import { ConnectEditor } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const textNode = (id: string, text: string, kind?: string) => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  text,
  ...(kind ? { ether: { entity: { kind } } } : {}),
});

const noop = () => {};

export const PickTarget = () => {
  const source = textNode("agent-1", "research agent", "agent");
  const doc = {
    nodes: [
      source,
      textNode("task-1", "sprint backlog", "task"),
      textNode("art-1", "build artifacts", "artifacts"),
      textNode("board-1", "fleet board", "board"),
    ],
    edges: [],
  };
  return (
    <Frame>
      <ConnectEditor node={source} doc={doc} open onOpenChange={noop} />
    </Frame>
  );
};

export const FromTaskSource = () => {
  const source = textNode("task-2", "customer requests", "requests");
  const doc = {
    nodes: [
      source,
      textNode("agent-2", "release agent", "agent"),
      textNode("agent-3", "support agent", "agent"),
      textNode("note-1", "Ship notes — read before triage"),
    ],
    edges: [],
  };
  return (
    <Frame>
      <ConnectEditor node={source} doc={doc} open onOpenChange={noop} />
    </Frame>
  );
};
