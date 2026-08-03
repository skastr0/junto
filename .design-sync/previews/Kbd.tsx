import { Kbd } from "@skastr0/vellum";

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

export const Keys = () => (
  <Frame>
    <Kbd>⌘K</Kbd>
    <Kbd>⌘Enter</Kbd>
    <Kbd>Esc</Kbd>
    <Kbd>Space + Drag</Kbd>
  </Frame>
);

export const Inline = () => (
  <Frame>
    <p style={{ color: "var(--color-ink-2)", fontSize: 12, lineHeight: 1.6, maxWidth: 320, margin: 0 }}>
      Press <Kbd>⌘K</Kbd> to open the command palette, or <Kbd>⌘Enter</Kbd> to assign the task.
    </p>
  </Frame>
);
