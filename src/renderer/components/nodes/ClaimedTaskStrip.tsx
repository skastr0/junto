import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { taskBrief } from "@shared/task";
import { claimedTaskForActorNode } from "../../lib/claimed-task";
import { state$ } from "../../lib/state";
import { INK } from "../../lib/theme";
import { stateHue } from "../work/WorkSurfaces";

/**
 * What this actor is working, on the node itself — every actor card carries it,
 * whether the seat is drawn as a terminal or as an agent. Same dot-and-brief
 * shape as the tasks node, so one task reads the same on both sides of the
 * edge. Renders nothing when the seat holds no active claim; node identity
 * alone is never claim authority, so the claim comes from the seat projection.
 */
export function ClaimedTaskStrip({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const claimed = claimedTaskForActorNode(doc, actorRefs, node.id);

  if (!claimed) return null;

  return (
    <div
      className="mt-1 truncate text-[10px] leading-snug"
      style={{ color: INK }}
      title={taskBrief(claimed.task)}
      data-testid="claimed-task"
    >
      <span style={{ color: stateHue(claimed.task.state) }}>●</span>{" "}
      {taskBrief(claimed.task)}
    </div>
  );
}
