/**
 * The core's handlers for the work socket's task.* and rulings ops (`TaskRpcs`). Owned by
 * cli-external. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does.
 */
import { TaskRpcs } from "../../contract/work/task";
import { WorkAdmission } from "./seat";

export const TaskServed = TaskRpcs.middleware(WorkAdmission);

export const TaskHandlers = TaskServed.toLayer(TaskServed.of({}));
