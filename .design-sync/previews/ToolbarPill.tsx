import { IconButton, ToolbarPill } from "@skastr0/vellum";
import { Flag, Pencil, Trash2 } from "lucide-react";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "flex",
      alignItems: "center",
      gap: 20,
      flexWrap: "wrap",
    }}
  >
    {children}
  </div>
);

export const EditDelete = () => (
  <Frame>
    <ToolbarPill>
      <IconButton aria-label="Edit label" title="edit label">
        <Pencil size={14} />
      </IconButton>
      <IconButton tone="danger" aria-label="Delete node" title="delete">
        <Trash2 size={14} />
      </IconButton>
    </ToolbarPill>
  </Frame>
);

export const ThreeActions = () => (
  <Frame>
    <ToolbarPill>
      <IconButton aria-label="Edit label" title="edit label">
        <Pencil size={14} />
      </IconButton>
      <IconButton tone="accent" aria-label="Flag node" title="flag">
        <Flag size={14} />
      </IconButton>
      <IconButton tone="danger" aria-label="Delete node" title="delete">
        <Trash2 size={14} />
      </IconButton>
    </ToolbarPill>
  </Frame>
);
