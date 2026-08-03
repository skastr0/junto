import { KindStrip } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, width: 420 }}>{children}</div>
);

// KindStrip takes zero props — node/edge selection is read entirely from the
// canvas runtime store. Standalone that selection is always empty, so the
// component's only reachable render is its real "no selection" cue — an
// accurate, always-valid app state (idle canvas), not a degraded fallback.
export const NoSelection = () => (
  <Frame>
    <div style={{ fontSize: 10, color: "rgba(143,163,176,0.85)", marginBottom: 10 }}>
      no props — kind actions key off canvas selection (runtime store), so
      this quiet cue is the component's real default/idle state
    </div>
    <div className="rts-panel rts-panel--mid" style={{ width: 320, position: "relative" }}>
      <div className="rts-panel__label">kind</div>
      <div className="rts-panel__body rts-mid-body">
        <KindStrip />
      </div>
    </div>
  </Frame>
);
