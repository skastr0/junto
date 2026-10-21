import { useState } from "react";
import { Minus, Plus, ShieldCheck, X } from "lucide-react";
import { Button, Chip, Dropdown, IconButton, type ChipTone } from "../ui";
import {
  reviewerChoices,
  stampOf,
  stampTally,
  type SeatChoice,
} from "../../lib/task-ui";
import type {
  SeatNodeId,
  Stamp,
  TaskActor,
  TaskCommand,
  TaskContext,
  TaskCore,
} from "@shared/task-machine";
import "./task-reviewers.css";

const stampTone = (stamp: Stamp | undefined): ChipTone =>
  stamp === undefined ? "steel" : stamp.verdict === "approve" ? "green" : "crimson";

const stampWord = (stamp: Stamp | undefined, waiting: boolean): string =>
  stamp === undefined
    ? waiting
      ? "waiting"
      : "no stamp yet"
    : stamp.verdict === "approve"
      ? "approved"
      : "asked for changes";

/**
 * Reviewers and stamps (plan 04 "Review stamps"). Replaces the single
 * "requires review" switch: a task asks for `required` approvals, names its
 * reviewers, and each reviewer's current stamp shows beside them. Stamps come
 * from reviewing seats (the ruler refuses the operator), so they are shown,
 * never authored, here; the operator edits the list and the count.
 */
export function TaskReviewers({
  task,
  actor,
  ctx,
  seats,
  pending = false,
  onCommand,
}: {
  readonly task: TaskCore;
  readonly actor: TaskActor;
  readonly ctx: TaskContext;
  /** Seats in reach, named. Reviewer names resolve through this. */
  readonly seats: ReadonlyArray<SeatChoice>;
  readonly pending?: boolean;
  readonly onCommand: (command: TaskCommand) => void;
}) {
  const [adding, setAdding] = useState("");
  const tally = stampTally(task);
  const closed =
    task.state === "done" || task.state === "canceled" || task.state === "archived";
  const nameOf = (seat: SeatNodeId): string =>
    seats.find((choice) => choice.node === seat)?.name ?? seat;
  const candidates = closed ? [] : reviewerChoices(task, actor, ctx, seats);
  const inReview = task.state === "in-review";
  const required = task.stampPolicy.required;

  return (
    <section
      className="task-reviewers"
      data-testid="task-reviewers"
      data-required={String(required)}
      aria-label="Reviewers and stamps"
    >
      <header className="task-reviewers__head">
        <span>Review</span>
        <div className="task-reviewers__policy">
          <ShieldCheck size={13} aria-hidden />
          {closed ? (
            <output aria-label="Approvals required">{required}</output>
          ) : (
            <>
              <IconButton
                aria-label="Require one fewer approval"
                title="Require one fewer approval"
                disabled={pending || required <= 0}
                onClick={() => onCommand({ kind: "stamp-policy", required: required - 1 })}
              >
                <Minus size={12} />
              </IconButton>
              <output aria-label="Approvals required" data-testid="task-required">
                {required}
              </output>
              <IconButton
                aria-label="Require one more approval"
                title="Require one more approval"
                disabled={pending}
                onClick={() => onCommand({ kind: "stamp-policy", required: required + 1 })}
              >
                <Plus size={12} />
              </IconButton>
            </>
          )}
          <span>{required === 0 ? "no stamps needed" : "approvals needed"}</span>
        </div>
      </header>

      {required > 0 && (inReview || tally.approvals + tally.changes > 0) ? (
        <div className="task-reviewers__tally">
          <Chip tone={tally.met ? "green" : "amber"}>
            {tally.approvals} of {tally.required} approved
          </Chip>
          {tally.changes > 0 ? <Chip tone="crimson">{tally.changes} asked for changes</Chip> : null}
        </div>
      ) : null}

      {task.reviewers.length === 0 ? (
        <p className="task-reviewers__empty">
          {required === 0
            ? "No reviewers. Finishing completes the task."
            : "No reviewers yet. Add a seat to ask for its stamp."}
        </p>
      ) : (
        <ul className="task-reviewers__list">
          {task.reviewers.map((reviewer) => {
            const stamp = stampOf(task, reviewer);
            return (
              <li
                key={reviewer}
                data-testid="task-reviewer"
                data-reviewer={reviewer}
                data-verdict={stamp?.verdict}
              >
                <strong>{nameOf(reviewer)}</strong>
                <Chip tone={stampTone(stamp)}>{stampWord(stamp, inReview)}</Chip>
                {stamp?.text ? <p>{stamp.text}</p> : null}
                {closed ? null : (
                  <IconButton
                    aria-label={`Remove ${nameOf(reviewer)} as reviewer`}
                    title="Remove reviewer"
                    disabled={pending}
                    onClick={() => onCommand({ kind: "reviewer-remove", seat: reviewer })}
                  >
                    <X size={12} />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {candidates.length > 0 ? (
        <div className="task-reviewers__add">
          <Dropdown
            aria-label="Add reviewer"
            value={adding}
            options={candidates.map((seat) => ({ value: seat.node, label: seat.name }))}
            onChange={setAdding}
            placeholder="Add reviewer…"
            disabled={pending}
          />
          <Button
            size="xs"
            variant="chrome"
            disabled={pending || adding === ""}
            onClick={() => {
              onCommand({ kind: "reviewer-add", seat: adding as SeatNodeId });
              setAdding("");
            }}
          >
            <Plus size={12} aria-hidden />
            Add
          </Button>
        </div>
      ) : null}
    </section>
  );
}
