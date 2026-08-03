import { RegionHoldControl } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20, maxWidth: 360 }}>
    {children}
  </div>
);

const region = (hold: boolean) => ({
  id: "region-1",
  type: "group",
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  label: "workshop",
  ...(hold ? { ether: { region: { hold: true } } } : {}),
});

export const Held = () => (
  <Frame>
    <RegionHoldControl node={region(true)} />
  </Frame>
);

export const NotHeld = () => (
  <Frame>
    <RegionHoldControl node={region(false)} />
  </Frame>
);
