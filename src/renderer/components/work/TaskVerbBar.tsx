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
  offeredVerbs,
  verbLabel,
  type SeatChoice,
  type TaskVerb,
} from "../../lib/task-ui";
import type {
  SeatNodeId,
  TaskActor,
  TaskCommand,
  TaskContext,
  TaskCore,
} from "@shared/task-machine";
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
  pending = false,
  onCommand,
}: {
  readonly task: TaskCore;
  readonly actor: TaskActor;
  readonly ctx: TaskContext;
  /** Seats in reach of the task's node. */
  readonly seats: ReadonlyArray<SeatChoice>;
  /** `#42` for a task id, to say which task keeps a seat busy. */
  readonly numberOf: (taskId: string) => string | undefined;
  readonly pending?: boolean;
  readonly onCommand: (command: TaskCommand) => void;
}) {
  const verbs = offeredVerbs(task, actor, ctx);
  const [seat, setSeat] = useState("");
  if (verbs.length === 0) return null;

  const run = (verb: TaskVerb) => {
    if (verb === "assign") {
      if (seat !== "") onCommand({ kind: "assign", seat: seat as SeatNodeId });
      return;
    }
    onCommand({ kind: verb });
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
              choice.refusal?.reason === "seat-busy"
                ? `holds ${numberOf(choice.refusal.taskId) ?? "a task"}`
                : undefined,
          }))}
          onChange={setSeat}
          placeholder="Assign to…"
          emptyLabel="no seats in reach"
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
            disabled={pending || (verb === "assign" && seat === "")}
            data-testid={`task-verb-${verb}`}
            onClick={() => run(verb)}
          >
            <Icon size={12} aria-hidden />
            {verbLabel(verb)}
          </Button>
        );
      })}
    </div>
  );
}
