import { EdgeCapabilitySection } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const entityNode = (id: string, text: string, kind: string) => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 220,
  height: 90,
  text,
  ether: { entity: { kind } },
});

export const AgentToTaskSink = () => {
  const from = entityNode("agent-1", "research agent", "agent");
  const to = entityNode("task-1", "sprint backlog", "task");
  return (
    <Frame>
      <EdgeCapabilitySection
        edge={{ id: "e1", fromNode: from.id, toNode: to.id }}
        fromNode={from}
        toNode={to}
      />
    </Frame>
  );
};

export const AgentToBoard = () => {
  const from = entityNode("agent-2", "release agent", "agent");
  const to = entityNode("board-1", "fleet board", "board");
  return (
    <Frame>
      <EdgeCapabilitySection
        edge={{ id: "e2", fromNode: from.id, toNode: to.id }}
        fromNode={from}
        toNode={to}
      />
    </Frame>
  );
};
