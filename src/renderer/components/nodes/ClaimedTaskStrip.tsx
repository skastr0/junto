import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { taskBrief } from "@shared/task";
import type { ClaimedTask } from "../../lib/claimed-task";
import { claimedTask$ } from "../../lib/claimed-task-index";
import { INK } from "../../lib/theme";
import { stateHue } from "../work/WorkSurfaces";

/**
 * What this actor is working, on the node itself — every actor card carries it,
 * whether the seat is drawn as a terminal or as an agent. Same dot-and-brief
 * shape as the tasks node, so one task reads the same on both sides of the
 * edge. Renders nothing when the seat holds no active claim; node identity
 * alone is never claim authority, so the claim comes from the seat projection.
 *
 * Reads one key of the canvas-wide claimed-task index. Up to one strip mounts
 * per seat, so subscribing to the whole document here made every unrelated
 * document write cost a full nodes x tasks scan per strip.
 */
export function ClaimedTaskStrip({ node }: { readonly node: CanvasNode }) {
  const claimed = use$(() => claimedTask$.byNodeId[node.id].get()) as
    | ClaimedTask
    | undefined;

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
