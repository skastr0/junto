import { FieldLabel, Textarea } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "grid",
      gap: 14,
      maxWidth: 340,
    }}
  >
    {children}
  </div>
);

export const WithLabel = () => (
  <Frame>
    <FieldLabel>
      Briefing
      <Textarea defaultValue="Stage the release build on the workshop mini, then let the fleet soak it overnight before promoting." />
    </FieldLabel>
  </Frame>
);

export const Placeholder = () => (
  <Frame>
    <FieldLabel>
      Notes
      <Textarea placeholder="what should the agent accomplish…" />
    </FieldLabel>
  </Frame>
);

export const Disabled = () => (
  <Frame>
    <FieldLabel>
      Briefing
      <Textarea defaultValue="Blocked: waiting on the license server fix." disabled />
    </FieldLabel>
  </Frame>
);
