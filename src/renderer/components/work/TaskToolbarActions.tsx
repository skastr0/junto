import { ListPlus } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { openTaskCreateSurface } from "../../lib/dock-state";
import { IconButton } from "../ui";

/** Selection-toolbar entry point for a task sink's quick enqueue surface. */
export function TaskToolbarActions({ node }: { readonly node: CanvasNode }) {
  return (
    <IconButton
      className="nodrag nopan"
      aria-label="Enqueue task"
      title="Enqueue task"
      data-testid="node-toolbar-task-enqueue"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openTaskCreateSurface(node, { mode: "task" });
      }}
    >
      <ListPlus size={14} />
    </IconButton>
  );
}
