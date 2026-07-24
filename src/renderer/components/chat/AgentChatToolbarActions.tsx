import { MessageSquareText } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { openAgentChatSurface } from "../../lib/dock-state";

/** Selection-toolbar entry point for the agent's ACP work surface. */
export function AgentChatToolbarActions({ node }: { readonly node: CanvasNode }) {
  return (
    <button
      type="button"
      aria-label="Open ACP chat"
      className="nodrag nopan grid size-7 place-items-center rounded text-cyan/75 transition hover:bg-white/10 hover:text-cyan"
      title="open ACP chat"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openAgentChatSurface(node);
      }}
    >
      <MessageSquareText size={14} />
    </button>
  );
}
