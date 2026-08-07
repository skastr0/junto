import { NodeFieldEditors } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

export const TextNote = () => (
  <Frame>
    <NodeFieldEditors
      node={{
        id: "note-1",
        type: "text",
        x: 0,
        y: 0,
        width: 240,
        height: 120,
        text: "Stage the release build on the workshop mini, then soak overnight before promoting.",
      }}
    />
  </Frame>
);

export const FileReference = () => (
  <Frame>
    <NodeFieldEditors
      node={{
        id: "file-1",
        type: "file",
        x: 0,
        y: 0,
        width: 220,
        height: 90,
        file: "~/Projects/vellum/AGENTS.md",
        subpath: "#testing",
      }}
    />
  </Frame>
);

// Agent-kind text node: label textarea + actor placement note +
// AgentMessagesPane. The messages list is prop-driven and shows truthfully.
export const AgentSeat = () => (
  <Frame>
    <NodeFieldEditors
      node={{
        id: "agent-1",
        type: "text",
        x: 0,
        y: 0,
        width: 240,
        height: 100,
        text: "research agent",
        ether: {
          entity: { kind: "agent", name: "remote-a:research" },
          messages: {
            items: [
              {
                messageId: "m1",
                role: "user",
                parts: [{ kind: "text", text: "Ship the release build tonight." }],
                metadata: { deliveredAt: Date.now() - 60_000 },
              },
              {
                messageId: "m2",
                role: "agent",
                parts: [{ kind: "text", text: "Kicking off the workshop mini build now." }],
              },
            ],
          },
        },
      }}
    />
  </Frame>
);
