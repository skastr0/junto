import { EdgePairStrip, SeedState } from "@skastr0/vellum";

// EdgePairStrip resolves both endpoint names and both endpoint kinds off the
// open canvas document, so SeedState is what makes the verb, the sentence, and
// the swap real rather than a caption describing them.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, width: 420 }}>{children}</div>
);

const agent = {
  id: "agent-1",
  type: "text" as const,
  text: "Release Agent",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "agent" } },
};

// agent → page holds exactly one verb, so there is nothing to swap to.
export const OneVerb = () => (
  <SeedState
    doc={{
      nodes: [
        agent,
        {
          id: "page-1",
          type: "text",
          text: "Status board",
          x: 260,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "page" } },
        },
      ],
      edges: [
        { id: "e-nav", fromNode: "agent-1", toNode: "page-1", ether: { verb: "navigates" } },
      ],
    }}
  >
    <Frame>
      <EdgePairStrip edge={{ id: "e-nav", fromNode: "agent-1", toNode: "page-1" } as never} />
    </Frame>
  </SeedState>
);

// agent → task holds two: contributing is the drawn default, managing is the
// deliberate narrowing. The swap names the sibling it would change to.
export const TwoVerbs = () => (
  <SeedState
    doc={{
      nodes: [
        agent,
        {
          id: "task-1",
          type: "text",
          text: "Ship checklist",
          x: 260,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [
        {
          id: "e-contributes",
          fromNode: "agent-1",
          toNode: "task-1",
          ether: { verb: "contributes" },
        },
      ],
    }}
  >
    <Frame>
      <EdgePairStrip
        edge={{ id: "e-contributes", fromNode: "agent-1", toNode: "task-1" } as never}
      />
    </Frame>
  </SeedState>
);

// A scheduler pushing into a seat: relay → agent also holds two, so the same
// swap appears on a wire that grants no port at all.
export const SchedulerPush = () => (
  <SeedState
    doc={{
      nodes: [
        {
          id: "relay-1",
          type: "text",
          text: "Nightly relay",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "relay" } },
        },
        { ...agent, id: "agent-2", x: 260 },
      ],
      edges: [
        { id: "e-wakes", fromNode: "relay-1", toNode: "agent-2", ether: { verb: "wakes" } },
      ],
    }}
  >
    <Frame>
      <EdgePairStrip edge={{ id: "e-wakes", fromNode: "relay-1", toNode: "agent-2" } as never} />
    </Frame>
  </SeedState>
);
