import { EdgeCriteriaEditor } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const entityNode = (id: string, text: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  text,
  ether: { entity: { kind }, ...extra },
});

// edgeId resolves the persisted edge (criteria/effect) against the app's
// global doc store, which the preview harness always leaves empty — so
// criteria/effect always read as unset (mode "none"). livePhase is passed
// straight through as a prop, so it must stay coherent with that unset
// state: "blocks" only ever occurs live once criteria IS wired, so these
// cells use "relates" (the honest pre-wiring phase) rather than a
// blocks+no-criteria combination the real app can't produce.
export const TaskSource = () => (
  <Frame>
    <EdgeCriteriaEditor
      edgeId="e1"
      fromNode={entityNode("task-1", "sprint backlog", "task")}
      livePhase="relates"
      liveDetail="sprint backlog holds 6 open items"
    />
  </Frame>
);

export const SchedulerSource = () => (
  <Frame>
    <EdgeCriteriaEditor
      edgeId="e2"
      fromNode={entityNode("timer-1", "nightly rebuild", "timer", { timer: { everyMinutes: 60 } })}
      livePhase="relates"
    />
  </Frame>
);
