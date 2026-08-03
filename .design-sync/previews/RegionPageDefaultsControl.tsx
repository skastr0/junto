import { RegionPageDefaultsControl } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const region = (defaults?: Record<string, unknown>) => ({
  id: "region-1",
  type: "group" as const,
  x: 0,
  y: 0,
  width: 320,
  height: 260,
  label: "workshop",
  ...(defaults ? { ether: { region: { defaults } } } : {}),
});

export const Filled = () => (
  <Frame>
    <RegionPageDefaultsControl
      node={region({
        page: { url: "https://github.com/notifications", profile: "personal", host: "remote-a" },
      })}
    />
  </Frame>
);

export const Empty = () => (
  <Frame>
    <RegionPageDefaultsControl node={region()} />
  </Frame>
);
