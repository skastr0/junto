import { FieldLabel, Input } from "@skastr0/vellum";

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
      Station name
      <Input defaultValue="remote-a — workshop" />
    </FieldLabel>
    <FieldLabel>
      Region folder
      <Input defaultValue="~/Projects/vellum" />
    </FieldLabel>
  </Frame>
);

export const Placeholder = () => (
  <Frame>
    <FieldLabel>
      Canvas name
      <Input placeholder="untitled canvas…" />
    </FieldLabel>
  </Frame>
);

export const Disabled = () => (
  <Frame>
    <FieldLabel>
      Host id
      <Input defaultValue="st-4f2a91" disabled />
    </FieldLabel>
  </Frame>
);
