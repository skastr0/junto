import { StatusDot } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "flex",
      alignItems: "center",
      gap: 16,
      flexWrap: "wrap",
    }}
  >
    {children}
  </div>
);

const Labeled = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    {children}
    <span style={{ color: "var(--color-dim)", fontSize: 11 }}>{label}</span>
  </div>
);

export const Tones = () => (
  <Frame>
    <Labeled label="live">
      <StatusDot tone="amber" />
    </Labeled>
    <Labeled label="synced">
      <StatusDot tone="cyan" />
    </Labeled>
    <Labeled label="blocked">
      <StatusDot tone="crimson" />
    </Labeled>
    <Labeled label="ready">
      <StatusDot tone="green" />
    </Labeled>
    <Labeled label="agent">
      <StatusDot tone="violet" />
    </Labeled>
    <Labeled label="idle">
      <StatusDot tone="steel" />
    </Labeled>
    <Labeled label="offline">
      <StatusDot tone="dim" />
    </Labeled>
  </Frame>
);

export const Pulse = () => (
  <Frame>
    <Labeled label="working">
      <StatusDot tone="amber" pulse />
    </Labeled>
    <Labeled label="claiming">
      <StatusDot tone="cyan" pulse />
    </Labeled>
  </Frame>
);

export const InList = () => (
  <Frame>
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusDot tone="amber" pulse />
        <span style={{ color: "var(--color-ink)", fontSize: 12 }}>profile-14 — working</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusDot tone="steel" />
        <span style={{ color: "var(--color-ink)", fontSize: 12 }}>Unclaimed</span>
      </div>
    </div>
  </Frame>
);
