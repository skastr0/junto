import { asNodeId } from "../../src/shared/model";
import { mintItemId } from "../../src/shared/resource-command";
import type { SeatTask } from "../../src/shared/seat-task-index";
import { blocksAssignee, taskNodeId, type OpenTaskState, type TaskCore, type TaskView } from "../../src/shared/task-model";

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

/** A task on the task node `node` as the store reads it: in backlog at epoch 0 unless a case says otherwise. */
export const taskView = (
  node: string,
  fields: { readonly title?: string; readonly stateSince?: number; readonly current?: Partial<TaskCore> } = {},
): TaskView => ({
  taskId: mintItemId(),
  title: fields.title ?? "approve delivery",
  current: { state: "backlog", node: taskNodeId(asNodeId(node)), epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [], ...fields.current },
  layers: [],
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
  stateSince: fields.stateSince ?? 1,
});
