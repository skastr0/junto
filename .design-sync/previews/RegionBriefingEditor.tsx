import { RegionBriefingEditor } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const region = (instruction?: string) => ({
  id: "region-1",
  type: "group",
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  label: "workshop",
  ...(instruction ? { ether: { region: { instruction } } } : {}),
});

export const Filled = () => (
  <Frame>
    <RegionBriefingEditor
      node={region(
        "Keep credentials local. Route anything touching billing to the operator before acting.",
      )}
    />
  </Frame>
);

export const Empty = () => (
  <Frame>
    <RegionBriefingEditor node={region()} />
  </Frame>
);
