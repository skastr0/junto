import { HelpMap, HelpMapGroup, HelpMapKeys, HelpMapPrimer, HelpMapPrimerBlock } from "@skastr0/vellum";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "flex",
      alignItems: "flex-start",
      gap: 16,
      flexWrap: "wrap",
    }}
  >
    {children}
  </div>
);

export const Composed = () => (
  <Frame>
    <HelpMap eyebrow="Protocol" title="Canvas shortcuts" onClose={() => {}}>
      <HelpMapGroup label="Pointer">
        <HelpMapKeys
          rows={[
            { keys: "Scroll", action: "Pan canvas" },
            { keys: "⌘ Scroll", action: "Zoom" },
            { keys: "Space + Drag", action: "Pan" },
          ]}
        />
      </HelpMapGroup>
      <HelpMapGroup label="Keys">
        <HelpMapKeys
          rows={[
            { keys: "⌘K", action: "Command palette" },
            { keys: "⌘Enter", action: "Assign task" },
          ]}
        />
      </HelpMapGroup>
    </HelpMap>
  </Frame>
);

export const Primer = () => (
  <Frame>
    <HelpMap eyebrow="Vocabulary" title="Fleet primer" tone="cyan" onClose={() => {}}>
      <HelpMapPrimer>
        <HelpMapPrimerBlock lead="Station">
          Each physical machine enrolled into the fleet. A <em>region</em> lives inside a station.
        </HelpMapPrimerBlock>
        <HelpMapPrimerBlock lead="Canvas">
          The source of truth for a project — the board only projects it.
        </HelpMapPrimerBlock>
      </HelpMapPrimer>
    </HelpMap>
  </Frame>
);
