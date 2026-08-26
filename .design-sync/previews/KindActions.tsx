import { KindActions } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
    {children}
  </div>
);

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <span
      style={{
        fontSize: 8,
        fontWeight: 600,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "rgba(143,163,176,0.85)",
        minWidth: 96,
      }}
    >
      {label}
    </span>
    <div className="rts-kind-strip" role="toolbar" aria-label={`${label} actions`}>
      {children}
    </div>
  </div>
);

const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 220,
  height: 120,
  ether: { entity: { kind }, ...extra },
});

// entity.kind "agent" is intentionally omitted — the managed terminal is the
// only agent surface and ACP chat stays hard-hidden, so KindActions returns
// null for it by product law, not by preview gap.
export const TerminalKind = () => (
  <Frame>
    <Row label="terminal">
      <KindActions node={node("shell-1", "terminal") as never} />
    </Row>
  </Frame>
);

export const WorkKinds = () => (
  <Frame>
    <Row label="task">
      <KindActions node={node("release-checklist", "task") as never} />
    </Row>
    <Row label="requests">
      <KindActions node={node("intake", "requests") as never} />
    </Row>
  </Frame>
);
