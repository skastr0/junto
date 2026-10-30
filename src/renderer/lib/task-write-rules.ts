/**
 * What a task write is refused for before it leaves the window. The wire's
 * limits are the ruler's own (task-control.ts), so a write over one would be
 * refused at the IPC boundary as a schema error rather than a ruling and the
 * pane would show nothing at all (a 240-character retitle vanished, found by
 * product-verify, 0.12). Checked here, it is refused in words the operator
 * can act on, and the typed text stays in the field to be shortened.
 */
import { TASK_TITLE_MAX_LENGTH } from "@shared/task-control";
import type { TaskCommand } from "@shared/task-model";

export const taskWriteRefusalOf = (command: TaskCommand): string | undefined => {
  if (command.kind !== "create" && command.kind !== "edit") return undefined;
  const title = command.title;
  if (title === undefined || title.length <= TASK_TITLE_MAX_LENGTH) return undefined;
  return `A title is at most ${TASK_TITLE_MAX_LENGTH} characters.`;
};
