import { asNodeId } from "../../src/shared/model";
import { mintItemId } from "../../src/shared/resource-command";
import type { SeatTask } from "../../src/shared/seat-task-index";
import { blocksAssignee, taskNodeId, type OpenTaskState } from "../../src/shared/task-model";

/** The task a seat holds, on the task node `node`: waiting for input unless a case says otherwise. */
export const heldTask = (
  node: string,
  fields: { readonly state?: OpenTaskState; readonly title?: string; readonly since?: number } = {},
): SeatTask => {
  const state = fields.state ?? "input-required";
  return {
    taskId: mintItemId(),
    label: "#1",
    title: fields.title ?? "approve delivery",
    state,
    node: taskNodeId(asNodeId(node)),
    blocked: blocksAssignee(state),
    ...(fields.since === undefined ? {} : { since: fields.since }),
  };
};
