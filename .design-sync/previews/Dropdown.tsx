import { Dropdown } from "@skastr0/vellum";

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

const CANVASES = [
  { value: "workshop", label: "workshop" },
  { value: "staging", label: "staging" },
  { value: "north-loop", label: "north-loop" },
];

const MODELS = [
  { value: "claude-opus", label: "Claude Opus" },
  { value: "claude-sonnet", label: "Claude Sonnet" },
  { value: "gpt-5", label: "GPT-5" },
];

export const Default = () => (
  <Frame>
    <div className="station-canvas">
      <Dropdown
        className="station-select-wrap"
        triggerClassName="station-select"
        aria-label="Active canvas"
        title="switch canvas"
        value="workshop"
        uppercase
        options={CANVASES}
        onChange={() => {}}
      />
    </div>
  </Frame>
);

export const Placeholder = () => (
  <Frame>
    <div style={{ width: 200 }}>
      <Dropdown
        triggerClassName="vellum-picker-select"
        aria-label="Model"
        value=""
        placeholder="select model…"
        options={MODELS}
        onChange={() => {}}
      />
    </div>
  </Frame>
);

export const Disabled = () => (
  <Frame>
    <div className="station-canvas">
      <Dropdown
        className="station-select-wrap"
        triggerClassName="station-select"
        aria-label="Active canvas"
        aria-busy
        title="opening canvas…"
        value="workshop"
        uppercase
        disabled
        options={CANVASES}
        onChange={() => {}}
      />
    </div>
  </Frame>
);
