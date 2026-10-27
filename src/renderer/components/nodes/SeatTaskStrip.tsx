import { use$ } from "@legendapp/state/react";
import { seatTasks$, type SeatTask } from "../../lib/seat-tasks";
import { INK } from "../../lib/theme";
import { TaskStateMark } from "../ui";

/**
 * The task this seat holds, on the node itself: every actor card carries it,
 * whether the seat is drawn as a terminal or as an agent. The same state mark
 * and number as the Tasks node, so one task reads the same on both sides of
 * the assignment. A seat holding several shows its lead task (a blocked one
 * first) and how many more. Renders nothing when the seat holds none.
 *
 * Reads one key of the canvas-wide seat task store (`seat-tasks.ts`), so a
 * write elsewhere on the canvas does not wake every strip.
 */
export function SeatTaskStrip({ nodeId }: { readonly nodeId: string }) {
  const held = use$(() => seatTasks$.bySeat[nodeId].get()) as SeatTask | undefined;
  if (!held) return null;
  const more = held.tasks.length - 1;
  return (
    <div
      className="mt-1 flex items-center gap-1 truncate text-caption leading-snug"
      style={{ color: INK }}
      title={held.tasks.map((task) => `${task.label} ${task.title}`).join("\n")}
      data-testid="seat-task"
    >
      <TaskStateMark state={held.state} />
      <span className="tabular-nums">{held.label}</span>
      <span className="truncate">{held.title}</span>
      {more > 0 ? <span className="shrink-0 tabular-nums" data-testid="seat-task-more">+{more}</span> : null}
    </div>
  );
}
