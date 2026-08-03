import { PauseScopeKey } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20 }}>{children}</div>
);

const Labeled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
    {children}
    <span
      style={{
        fontSize: 9,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "rgba(143,163,176,0.85)",
      }}
    >
      {label}
    </span>
  </div>
);

// paused/unpaused reflects the open canvas's runtime pause plane, not a
// prop. No canvas is mounted here, so the plane reads its born-paused
// default (@shared/pause: PAUSED_CANVAS) — canvas scope is !playing, which
// defaults true (amber, Play glyph — genuinely paused); node/region scope
// checks membership in pausedNodes/pausedRegions, which default empty
// (plain, Pause glyph — not paused). Real, distinct, grounded default states.
export const Scopes = () => (
  <Frame>
    <div style={{ fontSize: 10, color: "rgba(143,163,176,0.85)", marginBottom: 12, maxWidth: 420 }}>
      canvas / node / region scopes — a fresh canvas is born paused (canvas
      key shows amber/resume); node and region are only paused when
      explicitly listed, so they default to the ready-to-pause glyph
    </div>
    <div style={{ display: "flex", gap: 24 }}>
      <Labeled label="canvas">
        <PauseScopeKey scope={{ kind: "canvas" }} />
      </Labeled>
      <Labeled label="node">
        <PauseScopeKey scope={{ kind: "node", id: "agent-claude" }} />
      </Labeled>
      <Labeled label="region">
        <PauseScopeKey scope={{ kind: "region", id: "region-review-loop" }} />
      </Labeled>
    </div>
  </Frame>
);

export const InCommandRow = () => (
  <Frame>
    <div style={{ fontSize: 10, color: "rgba(143,163,176,0.85)", marginBottom: 8 }}>
      node command row — pause key sits first, ahead of the flag divider
    </div>
    <div
      className="rts-cmd-keys"
      role="toolbar"
      aria-label="Node actions"
      style={{ background: "rgba(12,11,10,0.94)", padding: 8, borderRadius: 8, display: "inline-flex" }}
    >
      <PauseScopeKey scope={{ kind: "node", id: "agent-claude" }} />
      <span className="rts-cmd-keys__rule" aria-hidden />
    </div>
  </Frame>
);
