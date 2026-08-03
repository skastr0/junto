import { IconButton } from "@skastr0/vellum";
import { Pencil, Sparkles, Trash2 } from "lucide-react";

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

export const Tones = () => (
  <Frame>
    <IconButton aria-label="Edit label" title="edit label">
      <Pencil size={14} />
    </IconButton>
    <IconButton tone="accent" aria-label="Highlight node" title="highlight">
      <Sparkles size={14} />
    </IconButton>
    <IconButton tone="danger" aria-label="Delete node" title="delete">
      <Trash2 size={14} />
    </IconButton>
  </Frame>
);

export const Sizes = () => (
  <Frame>
    <IconButton size="md" aria-label="Edit label" title="edit label">
      <Pencil size={14} />
    </IconButton>
    <IconButton size="sm" aria-label="Edit label" title="edit label">
      <Pencil size={12} />
    </IconButton>
  </Frame>
);

export const Disabled = () => (
  <Frame>
    <IconButton disabled aria-label="Edit label" title="edit label">
      <Pencil size={14} />
    </IconButton>
    <IconButton disabled tone="danger" aria-label="Delete node" title="delete">
      <Trash2 size={14} />
    </IconButton>
  </Frame>
);
