import { Chip } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "flex",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    }}
  >
    {children}
  </div>
);

export const Tones = () => (
  <Frame>
    <Chip tone="amber">WORKING 2</Chip>
    <Chip tone="cyan">SYNCED</Chip>
    <Chip tone="violet">AGENT</Chip>
    <Chip tone="crimson">BLOCKED</Chip>
    <Chip tone="steel">IDLE</Chip>
    <Chip tone="green">READY</Chip>
  </Frame>
);

export const OnNode = () => (
  <Frame>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, color: "var(--color-ink)" }}>
        codex — remote-a
      </span>
      <Chip tone="cyan" title="placement: remote-a">
        remote-a
      </Chip>
      <Chip tone="steel" title="assignment: profile-14">
        profile-14
      </Chip>
    </div>
  </Frame>
);
