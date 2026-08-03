import { RegionHerdrDefaultsControl } from "@skastr0/vellum";

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
    <RegionHerdrDefaultsControl
      node={region({
        herdr: { host: "remote-a", session: "nightly", workspaceId: "vellum-workshop", tabId: "build" },
      })}
    />
  </Frame>
);

export const Empty = () => (
  <Frame>
    <RegionHerdrDefaultsControl node={region()} />
  </Frame>
);
