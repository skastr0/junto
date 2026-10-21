/**
 * A task fact as it crosses machines inside a `ruling.applied` row (02, "Facts
 * replicate to every machine"). A machine that does not edit the canvas
 * decodes the editing machine's facts with this before it folds them into its
 * own task tables; a fact that does not decode is never folded.
 *
 * Node ids are plain here, as in `TaskCommandWire`: a schema cannot know a
 * node's kind, and the editing machine already narrowed them when it ruled.
 */
import { Result, Schema } from "effect";
import { NodeId } from "./physics/schema";
import type { TaskFact } from "./task-machine";
import { TASK_STATES } from "./task-model";
import { ItemId, TaskNumber } from "./work-ids";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Reviewer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), seat: NodeId }),
  Schema.Struct({ kind: Schema.Literal("operator") }),
]);

const Stamp = Schema.Struct({
  reviewer: Reviewer,
  verdict: Schema.Literals(["approve", "changes"]),
  epoch: Count,
  subjectHash: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  at: Schema.Number,
});

const CheckResult = Schema.Struct({
  checkId: Schema.String,
  side: Schema.Literals(["outgoing", "incoming"]),
  command: Schema.String,
  exitCode: Schema.Int,
  outputTail: Schema.String,
  epoch: Count,
  destination: Schema.optionalKey(NodeId),
  at: Schema.Number,
});

const coreFields = {
  state: Schema.Literals(TASK_STATES),
  node: NodeId,
  assignee: Schema.optionalKey(NodeId),
  epoch: Count,
  stampPolicy: Schema.Struct({ required: Count }),
  reviewers: Schema.Array(Reviewer),
  stamps: Schema.Array(Stamp),
  checks: Schema.optionalKey(Schema.Array(CheckResult)),
  next: Schema.optionalKey(NodeId),
};

const TaskEffect = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("number-minted"), number: TaskNumber }),
  Schema.Struct({ kind: Schema.Literal("assignment-notice"), seat: NodeId }),
  Schema.Struct({ kind: Schema.Literal("stamp-request"), reviewer: Reviewer }),
  Schema.Struct({ kind: Schema.Literal("defect"), epoch: Count, by: Reviewer, text: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("sent-on"), from: NodeId, to: NodeId, layer: Schema.Struct(coreFields) }),
]);

const TaskFactWire = Schema.Struct({
  kind: Schema.Literal("task"),
  task: Schema.Struct({
    ...coreFields,
    id: ItemId,
    number: TaskNumber,
    title: Schema.String,
    body: Schema.optionalKey(Schema.String),
    dependsOn: Schema.Array(ItemId),
  }),
  effects: Schema.Array(TaskEffect),
});

const decode = Schema.decodeUnknownResult(Schema.Array(TaskFactWire), { onExcessProperty: "error" });

/** The editing machine's task facts, or undefined when any does not decode. */
export const decodeTaskFacts = (facts: unknown): ReadonlyArray<TaskFact> | undefined => {
  const decoded = decode(facts);
  // Only the seat and task node brands differ, and the ruler narrowed those.
  return Result.isFailure(decoded) ? undefined : (decoded.success as ReadonlyArray<TaskFact>);
};
