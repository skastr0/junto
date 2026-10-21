import { useState } from "react";
import {
  Archive,
  CheckCircle2,
  Pause,
  Play,
  RotateCcw,
  UserMinus,
  UserPlus,
  XCircle,
} from "lucide-react";
import { Button, Dropdown, type ButtonVariant } from "../ui";
import {
  assignChoices,
  nextChoices,
  offeredVerbs,
  verbLabel,
  type CommandOutcome,
  type SeatChoice,
  type TaskVerb,
} from "../../lib/task-ui";
import type { TaskContext } from "@shared/task-machine";
import type {
  SeatNodeId,
  TaskActor,
  TaskCommand,
  TaskCore,
  TaskId,
  TaskNodeId,
} from "@shared/task-model";
import "./task-verbs.css";

const VERB_ICON: Record<TaskVerb, typeof Play> = {
  assign: UserPlus,
  unassign: UserMinus,
  start: Play,
  pause: Pause,
  resume: RotateCcw,
  finish: CheckCircle2,
  cancel: XCircle,
  archive: Archive,
};

const VERB_VARIANT: Record<TaskVerb, ButtonVariant> = {
  assign: "primary",
  unassign: "subtle",
  start: "primary",
  pause: "chrome",
  resume: "primary",
  finish: "primary",
  cancel: "danger",
  archive: "subtle",
};

/**
 * The verbs a task allows its viewer right now (plan 04). Which verbs show is
 * the ruler's answer (`offeredVerbs`); this only draws them. Assign picks a
 * seat in reach; a seat that already holds a task shows disabled with the
 * task it holds.
 */
export function TaskVerbBar({
  task,
  actor,
  ctx,
  seats,
  numberOf,
  nodeName = (node) => node,
  pending = false,
  onCommand,
}: {
  readonly task: TaskCore;
  readonly actor: TaskActor;
  readonly ctx: TaskContext;
  /** Seats in reach of the task's node. */
  readonly seats: ReadonlyArray<SeatChoice>;
  /** `#42` for a task id, to say which task keeps a seat busy. */
  readonly numberOf: (taskId: TaskId) => string | undefined;
  /** Name of a task node, for the send-on picker. */
  readonly nodeName?: (node: TaskNodeId) => string;
  readonly pending?: boolean;
  /** Rules the command; answers why it was refused, or nothing when it was ruled. */
  readonly onCommand: (command: TaskCommand) => CommandOutcome;
}) {
  const verbs = offeredVerbs(task, actor, ctx);
  const [seat, setSeat] = useState("");
  const [next, setNext] = useState("");
  const [refused, setRefused] = useState<string | undefined>();
  const downstream = nextChoices(ctx);
  const needsNext = downstream.length > 1;
  if (verbs.length === 0) return null;

  const send = async (command: TaskCommand) => {
    setRefused(undefined);
    const outcome = await onCommand(command);
    if (typeof outcome === "string") setRefused(outcome);
  };

  const run = (verb: TaskVerb) => {
    if (verb === "assign") {
      if (seat !== "") void send({ kind: "assign", seat: seat as SeatNodeId });
      return;
    }
    if (verb === "finish") {
      void send(next === "" ? { kind: "finish" } : { kind: "finish", next: next as TaskNodeId });
      return;
    }
    void send({ kind: verb });
  };

  return (
    <div className="task-verbs" role="group" aria-label="Task actions" data-testid="task-verbs">
      {verbs.includes("assign") ? (
        <Dropdown
          aria-label="Assign to"
          value={seat}
          options={assignChoices(task, actor, ctx, seats).map((choice) => ({
            value: choice.node,
            label: choice.name,
            disabled: choice.refusal !== undefined,
            detail:
              choice.refusal?.kind === "seat-busy"
                ? `holds ${numberOf(choice.refusal.taskId) ?? "a task"}`
                : undefined,
          }))}
          onChange={setSeat}
          placeholder="Assign to…"
          emptyLabel="no seats in reach"
          disabled={pending}
        />
      ) : null}
      {verbs.includes("finish") && needsNext ? (
        <Dropdown
          aria-label="Send on to"
          value={next}
          options={downstream.map((node) => ({ value: node, label: nodeName(node) }))}
          onChange={setNext}
          placeholder="Send on to…"
          disabled={pending}
        />
      ) : null}
      {verbs.map((verb) => {
        const Icon = VERB_ICON[verb];
        return (
          <Button
            key={verb}
            size="xs"
            variant={VERB_VARIANT[verb]}
            disabled={
              pending ||
              (verb === "assign" && seat === "") ||
              (verb === "finish" && needsNext && next === "")
            }
            data-testid={`task-verb-${verb}`}
            onClick={() => run(verb)}
          >
            <Icon size={12} aria-hidden />
            {verbLabel(verb)}
          </Button>
        );
      })}
      {refused === undefined ? null : (
        <p className="task-verbs__refused" role="alert" data-testid="task-verbs-refused">
          {refused}
        </p>
      )}
    </div>
  );
}
