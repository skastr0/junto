import { RegionBackgroundEditor } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const region = (extra: Record<string, unknown> = {}) => ({
  id: "region-1",
  type: "group",
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  label: "workshop",
  ...extra,
});

export const ImageConfigured = () => (
  <Frame>
    <RegionBackgroundEditor
      node={region({
        background: "https://cdn.vellum.dev/regions/workshop-floor.jpg",
        backgroundStyle: "cover",
      })}
    />
  </Frame>
);

export const Empty = () => (
  <Frame>
    <RegionBackgroundEditor node={region()} />
  </Frame>
);
