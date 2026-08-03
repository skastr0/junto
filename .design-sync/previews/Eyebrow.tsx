import { Eyebrow } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "flex",
      alignItems: "flex-start",
      gap: 20,
      flexWrap: "wrap",
    }}
  >
    {children}
  </div>
);

const Stack = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "grid", gap: 4 }}>{children}</div>
);

export const Tones = () => (
  <Frame>
    <Stack>
      <Eyebrow tone="steel">Station</Eyebrow>
      <div style={{ color: "var(--color-ink)", fontSize: 13 }}>remote-a — workshop</div>
    </Stack>
    <Stack>
      <Eyebrow tone="cyan">Document</Eyebrow>
      <div style={{ color: "var(--color-ink)", fontSize: 13 }}>design-notes.md</div>
    </Stack>
    <Stack>
      <Eyebrow tone="amber">Attention</Eyebrow>
      <div style={{ color: "var(--color-ink)", fontSize: 13 }}>3 blocked tasks</div>
    </Stack>
    <Stack>
      <Eyebrow tone="faint">Detail</Eyebrow>
      <div style={{ color: "var(--color-ink)", fontSize: 13 }}>created 2 days ago</div>
    </Stack>
  </Frame>
);

export const Sizes = () => (
  <Frame>
    <Stack>
      <Eyebrow tone="steel" size="sm">
        Region
      </Eyebrow>
      <div style={{ color: "var(--color-ink)", fontSize: 13 }}>north-loop</div>
    </Stack>
    <Stack>
      <Eyebrow tone="steel" size="xs">
        Region
      </Eyebrow>
      <div style={{ color: "var(--color-ink)", fontSize: 13 }}>north-loop</div>
    </Stack>
  </Frame>
);
