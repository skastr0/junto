import { FieldLabel, Input, Select, Textarea } from "@skastr0/vellum";

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

export const WithInput = () => (
  <Frame>
    <FieldLabel>
      Fleet name
      <Input defaultValue="north-loop" />
    </FieldLabel>
  </Frame>
);

export const WithSelect = () => (
  <Frame>
    <FieldLabel>
      Region
      <Select
        aria-label="Region"
        value="north-loop"
        options={[
          { value: "north-loop", label: "north-loop" },
          { value: "workshop", label: "workshop" },
          { value: "staging", label: "staging" },
        ]}
        onChange={() => {}}
      />
    </FieldLabel>
  </Frame>
);

export const WithTextarea = () => (
  <Frame>
    <FieldLabel>
      Briefing
      <Textarea placeholder="what should the agent accomplish…" />
    </FieldLabel>
  </Frame>
);
