import { InspectorPanel, SeedState } from "@skastr0/vellum";

// InspectorPanel is zero-prop — it reads state$.selectedNodeId / state$.doc off
// the app's global store. SeedState (ds-extras.tsx) seeds that store inside
// the bundle before children render, so the real settings column shows up
// instead of the component's `if (!node && !edgeId) return null` branch.
// `.inspector-panel` is `position: absolute; top:18px; right:18px` against
// its nearest positioned ancestor, sized via `max-height: calc(100% - ...)`
// — Frame supplies `position: relative` + an explicit height so it docks
// the way it does inside the app's canvas viewport instead of floating
// against the page.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      position: "relative",
      width: 380,
      height: 640,
    }}
  >
    {children}
  </div>
);

// Agent seat selected — the AgentSeatSection branch (harness + title), plus
// the shared node sections every non-label node gets: placement chip,
// capability inventory (empty here — no edges), and the
// per-agent messages pane. `text` is the seat's display name, per the
// nodeTitle first-line convention (nodeTitle reads a text node's first line).
export const AgentSeatSelected = () => (
  <SeedState
    doc={{
      nodes: [
        {
          id: "n-agent",
          type: "text",
          text: "Release Engineer",
          x: 0,
          y: 0,
          width: 220,
          height: 100,
          ether: { entity: { kind: "agent" } },
        },
      ],
      edges: [],
    }}
    selectedNodeId="n-agent"
  >
    <Frame>
      <InspectorPanel />
    </Frame>
  </SeedState>
);

// Plain note selected — no ether.entity, so NodeInspector takes the
// `!isEntity && node.type === "text"` branch: title is the first line,
// NoteMarkdown renders everything after it as the note body.
export const TextNoteSelected = () => (
  <SeedState
    doc={{
      nodes: [
        {
          id: "n-note",
          type: "text",
          text: "Region briefing\nConfirm the release checklist before the nightly sweep starts.",
          x: 0,
          y: 0,
          width: 240,
          height: 140,
        },
      ],
      edges: [],
    }}
    selectedNodeId="n-note"
  >
    <Frame>
      <InspectorPanel />
    </Frame>
  </SeedState>
);
