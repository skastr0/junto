import { RegionPauseDot } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
    {children}
  </div>
);

export const Row = () => (
  <Frame>
    <div style={{ fontSize: 10, color: "rgba(143,163,176,0.85)" }}>
      region hotbar dot — unpaused glyph (pause is a canvas-runtime switch, not a prop)
    </div>
    <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#ede6da" }}>
        factory-north
        <RegionPauseDot regionId="region-factory-north" />
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#ede6da" }}>
        review-loop
        <RegionPauseDot regionId="region-review-loop" />
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#ede6da" }}>
        spawn-bay
        <RegionPauseDot regionId="region-spawn-bay" />
      </span>
    </div>
  </Frame>
);

export const InHotbarChip = () => (
  <Frame>
    <div style={{ fontSize: 10, color: "rgba(143,163,176,0.85)" }}>in a slotted hotbar chip</div>
    <div style={{ display: "flex", gap: 6 }}>
      <div className="rts-chip rts-chip--strip" style={{ cursor: "default" }}>
        <span className="rts-chip__slot">1</span>
        <span className="rts-chip__label">factory-north</span>
        <RegionPauseDot regionId="region-factory-north" />
      </div>
      <div className="rts-chip rts-chip--strip is-active" style={{ cursor: "default" }}>
        <span className="rts-chip__slot">2</span>
        <span className="rts-chip__label">review-loop</span>
        <RegionPauseDot regionId="region-review-loop" />
      </div>
    </div>
  </Frame>
);
