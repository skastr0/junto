import { ExecutionCardHeader } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "grid",
      gap: 14,
      maxWidth: 280,
    }}
  >
    {children}
  </div>
);

const Decal = ({ letter, tone }: { readonly letter: string; readonly tone: string }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: 26,
      height: 26,
      borderRadius: 7,
      flexShrink: 0,
      fontFamily: "monospace",
      fontSize: 12,
      fontWeight: 700,
      color: tone,
      background: "rgba(255,255,255,0.06)",
      border: `1px solid ${tone}55`,
    }}
  >
    {letter}
  </div>
);

export const Working = () => (
  <Frame>
    <ExecutionCardHeader
      decal={<Decal letter="C" tone="#39C6D6" />}
      title="claude-code — build sweep"
      subtitle="remote-a — workshop"
      activity={{ mode: "wave", tone: "cyan", pattern: "snake", label: "working" }}
    />
  </Frame>
);

export const Blocked = () => (
  <Frame>
    <ExecutionCardHeader
      decal={<Decal letter="X" tone="#E5484D" />}
      title="codex — release gate"
      subtitle="waiting on upstream request"
      activity={{ mode: "wave", tone: "crimson", pattern: "arrow-up", label: "blocked" }}
    />
  </Frame>
);

export const ReadyPulse = () => (
  <Frame>
    <ExecutionCardHeader
      decal={<Decal letter="G" tone="#5FB98E" />}
      title="grok — nightly digest"
      subtitle="completed 2m ago"
      activity={{ mode: "pulse", tone: "green", label: "ready — waiting for look" }}
    />
  </Frame>
);

export const Idle = () => (
  <Frame>
    <ExecutionCardHeader
      decal={<Decal letter=">" tone="#8FA3B0" />}
      title="terminal — remote-a shell"
      subtitle="idle"
      activity={{ mode: "static", tone: "steel", label: "idle" }}
    />
  </Frame>
);
