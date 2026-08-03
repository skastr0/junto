import { Button } from "@skastr0/vellum";

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

export const Variants = () => (
  <Frame>
    <Button variant="primary">Launch agent</Button>
    <Button variant="chrome">Open inspector</Button>
    <Button variant="subtle">Cancel</Button>
    <Button variant="danger">Delete node</Button>
  </Frame>
);

export const Sizes = () => (
  <Frame>
    <Button variant="primary" size="md">
      Enroll station
    </Button>
    <Button variant="chrome" size="sm">
      Assign task
    </Button>
    <Button variant="chrome" size="xs">
      Pin
    </Button>
  </Frame>
);

export const Disabled = () => (
  <Frame>
    <Button variant="primary" disabled>
      Launch agent
    </Button>
    <Button variant="chrome" disabled>
      Open inspector
    </Button>
  </Frame>
);
