import { KindSurface } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, width: 420 }}>{children}</div>
);

// KindSurface takes zero props — identity glance, kind actions, and the
// fields toggle all key off canvas selection (runtime store). Standalone,
// selection is always empty, so the component's only reachable render is its
// real idle cue — an accurate always-valid state, not a degraded fallback.
export const NoSelection = () => (
  <Frame>
    <div style={{ fontSize: 10, color: "rgba(143,163,176,0.85)", marginBottom: 10 }}>
      no props — glance + actions key off canvas selection (runtime store),
      so this quiet cue is the component's real default/idle state
    </div>
    <div className="rts-panel rts-panel--mid" style={{ width: 320, position: "relative" }}>
      <div className="rts-panel__label">kind</div>
      <div className="rts-panel__body rts-mid-body">
        <KindSurface />
      </div>
    </div>
  </Frame>
);
