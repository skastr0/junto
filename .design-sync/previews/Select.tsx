import { FieldLabel, Select } from "@skastr0/vellum";

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

const REGIONS = [
  { value: "north-loop", label: "north-loop" },
  { value: "workshop", label: "workshop" },
  { value: "staging", label: "staging" },
];

export const WithLabel = () => (
  <Frame>
    <FieldLabel>
      Region
      <Select aria-label="Region" value="north-loop" options={REGIONS} onChange={() => {}} />
    </FieldLabel>
    <FieldLabel>
      Status
      <Select
        aria-label="Status"
        value="blocked"
        options={[
          { value: "ready", label: "ready" },
          { value: "working", label: "working" },
          { value: "blocked", label: "blocked" },
        ]}
        onChange={() => {}}
      />
    </FieldLabel>
  </Frame>
);

export const Dense = () => (
  <Frame>
    <FieldLabel>
      Placement
      <Select aria-label="Placement" value="workshop" options={REGIONS} dense onChange={() => {}} />
    </FieldLabel>
  </Frame>
);

export const Disabled = () => (
  <Frame>
    <FieldLabel>
      Region
      <Select aria-label="Region" value="north-loop" options={REGIONS} disabled onChange={() => {}} />
    </FieldLabel>
  </Frame>
);
