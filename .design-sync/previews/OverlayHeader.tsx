import { IconButton, OverlayHeader } from "@skastr0/vellum";
import { Maximize2, X } from "lucide-react";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "flex",
      flexDirection: "column",
      gap: 16,
      width: 420,
    }}
  >
    {children}
  </div>
);

export const WithActions = () => (
  <Frame>
    <OverlayHeader
      eyebrow="Station"
      title="remote-a — workshop"
      status="ACP — live"
      actions={
        <>
          <IconButton aria-label="Maximize" title="maximize">
            <Maximize2 size={14} />
          </IconButton>
          <IconButton aria-label="Close" title="close">
            <X size={14} />
          </IconButton>
        </>
      }
    />
  </Frame>
);

export const TitleOnly = () => (
  <Frame>
    <OverlayHeader title="design-notes.md" />
  </Frame>
);
