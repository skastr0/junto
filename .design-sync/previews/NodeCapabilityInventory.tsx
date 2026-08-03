import { NodeCapabilityInventory, SeedState } from "@skastr0/vellum";

// NodeCapabilityInventory builds its neighbor list from
// canvasDocToCapabilityView(state$.doc) — an undirected adjacency read off
// the app's global doc store. SeedState seeds a doc with an agent connected
// to a few capability-bearing edges so the inventory has real rows.
//
// FINDING (see .design-sync/learnings/rescue.md): `.inspector-binding`'s peer
// title span (`min-w-0 flex-1 truncate`) sits next to a ports span that is
// only content-shrinkable (`flex: 0 1 auto` + ellipsis-on-last-child). Flex
// distributes shrink by (shrink-factor × flex-basis); the title's Tailwind
// `flex-1` basis is 0%, so whenever a row's total content overflows the
// column (any peer with more than ~2 short ports), 100% of the shrink lands
// on the title and it renders at 0px width — the peer's name vanishes
// entirely, leaving only the kind label and the port list. The short
// (msg-only) actor↔actor row does not overflow, so its title survives —
// both are seeded below so the contrast is visible in one screenshot.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 400 }}>
    {children}
  </div>
);

const agent1 = {
  id: "agent-1",
  type: "text" as const,
  text: "Fulfillment Agent",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "agent" } },
};

const task1 = {
  id: "task-1",
  type: "text" as const,
  text: "Ship v2.4",
  x: 260,
  y: -160,
  width: 200,
  height: 80,
  ether: { entity: { kind: "task" } },
};

const board1 = {
  id: "board-1",
  type: "text" as const,
  text: "Crew Board",
  x: 260,
  y: -40,
  width: 200,
  height: 80,
  ether: { entity: { kind: "board" } },
};

const agent3 = {
  id: "agent-3",
  type: "text" as const,
  text: "QA Agent",
  x: 260,
  y: 80,
  width: 200,
  height: 80,
  ether: { entity: { kind: "agent" } },
};

const artifacts1 = {
  id: "artifacts-1",
  type: "text" as const,
  text: "Release Artifacts",
  x: 260,
  y: 200,
  width: 200,
  height: 80,
  ether: { entity: { kind: "artifacts" } },
};

const doc = {
  nodes: [agent1, task1, board1, agent3, artifacts1],
  edges: [
    { id: "e-agent-task", fromNode: "agent-1", toNode: "task-1" },
    { id: "e-agent-board", fromNode: "agent-1", toNode: "board-1" },
    { id: "e-agent-agent", fromNode: "agent-1", toNode: "agent-3" },
    { id: "e-agent-artifacts", fromNode: "agent-1", toNode: "artifacts-1" },
  ],
};

// Self is an actor: "reaches" label, one row per connected peer. Task/board
// (4-6 ports) trigger the flex-shrink title collapse above; the agent peer
// (2 short msg.* ports) does not — same row markup, different outcome.
export const AgentReaches = () => (
  <SeedState doc={doc}>
    <Frame>
      <NodeCapabilityInventory node={agent1} />
    </Frame>
  </SeedState>
);

// Self is a sink: "reached by" label, actor callers only (the board/other-
// sink peers are filtered out — sink role only lists actor callers). Stacks
// two sinks with the same single caller to contrast a long offer list
// (task: 6 ports, title collapses) against a short one (artifacts: 1 port,
// title survives).
export const SinkReachedBy = () => (
  <SeedState doc={doc}>
    <Frame>
      <div style={{ marginBottom: 18 }}>
        <NodeCapabilityInventory node={task1} />
      </div>
      <NodeCapabilityInventory node={artifacts1} />
    </Frame>
  </SeedState>
);
