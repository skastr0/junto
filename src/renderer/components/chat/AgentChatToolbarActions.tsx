import { MessageSquareText } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { ACP_CHAT_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { openAgentChatSurface } from "../../lib/dock-state";
import { IconButton } from "../ui";

/** Selection-toolbar entry point for the agent's ACP work surface. */
export function AgentChatToolbarActions({ node }: { readonly node: CanvasNode }) {
  // Terminal is the only agent surface; ACP chat UI is hard-hidden.
  if (ACP_CHAT_SURFACE_HIDDEN) return null;

  return (
    <IconButton
      className="nodrag nopan"
      aria-label="Open ACP chat"
      title="open ACP chat"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openAgentChatSurface(node);
      }}
    >
      <MessageSquareText size={14} />
    </IconButton>
  );
}
