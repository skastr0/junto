import { EdgePairStrip } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, display: "flex", flexDirection: "column", gap: 18, width: 420 }}>
    {children}
  </div>
);

const Caption = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 10, color: "rgba(143,163,176,0.85)", marginBottom: 4 }}>{children}</div>
);

const edge = (id: string, fromNode: string, toNode: string, criteria?: Record<string, unknown>) => ({
  id,
  fromNode,
  toNode,
  ether: criteria ? { criteria } : undefined,
});

// Endpoint names read "? → ?": the strip resolves them from the open canvas
// document (a runtime store this preview mounts empty), never from the edge
// prop's id strings — captions above name the intended relation instead.
export const SoftRelates = () => (
  <Frame>
    <Caption>claude-agent → release-checklist · no criteria authored</Caption>
    <EdgePairStrip edge={edge("e1", "claude-agent", "release-checklist") as never} />
  </Frame>
);

export const TasksCriteria = () => (
  <Frame>
    <Caption>intake-agent → triage-tasks · stops flow until tasks clear</Caption>
    <EdgePairStrip edge={edge("e2", "intake-agent", "triage-tasks", { mode: "tasks" }) as never} />
  </Frame>
);

export const TrustPlane = () => (
  <Frame>
    <Caption>reviewer → release-gate · proof required</Caption>
    <EdgePairStrip edge={edge("e3", "reviewer", "release-gate", { mode: "proof", step: "smoke-test" }) as never} />
    <Caption>ops → prod-deploy · human approval required</Caption>
    <EdgePairStrip edge={edge("e4", "ops", "prod-deploy", { mode: "approval", step: "deploy" }) as never} />
  </Frame>
);
