import { useState } from "react";
import { Check, Minus, Plus, ShieldCheck, X } from "lucide-react";
import { Button, Chip, Dropdown, IconButton, StampTally, type ChipTone } from "../ui";
import {
  offeredStamps,
  operatorMayReview,
  reviewTally,
  reviewerChoices,
  stampOf,
  type CommandOutcome,
  type SeatChoice,
} from "../../lib/task-ui";
import type { TaskContext } from "@shared/task-machine";
import {
  reviewerKey,
  type Reviewer,
  type SeatNodeId,
  type Stamp,
  type TaskActor,
  type TaskCommand,
  type TaskCore,
} from "@shared/task-model";
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

const OPERATOR_ADD = "operator";

/**
 * Reviewers and stamps (plan 04 "Review stamps"). A task asks for `required`
 * approvals, names its reviewers (seats in reach, and the operator, whose
 * approval counts listed or not), and each reviewer's current stamp shows
 * beside them. The operator edits the list and the count and, while the task
 * is in review, stamps it from here. What shows is the ruler's answer.
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
  /** Rules the command; answers why it was refused, or nothing when it was ruled. */
  readonly onCommand: (command: TaskCommand) => CommandOutcome;
}) {
  const [adding, setAdding] = useState("");
  const [refused, setRefused] = useState<string | undefined>();
  const tally = reviewTally(task);
  const closed =
    task.state === "done" || task.state === "canceled" || task.state === "archived";
  const nameOf = (reviewer: Reviewer): string =>
    reviewer.kind === "operator"
      ? "You"
      : (seats.find((choice) => choice.node === reviewer.seat)?.name ?? reviewer.seat);
  const candidates = closed ? [] : reviewerChoices(task, actor, ctx, seats);
  const addOptions = [
    ...(!closed && operatorMayReview(task, ctx)
      ? [{ value: OPERATOR_ADD, label: "Me (operator)" }]
      : []),
    ...candidates.map((seat) => ({ value: seat.node as string, label: seat.name })),
  ];
  const stamps = closed ? [] : offeredStamps(task, actor, ctx);
  const inReview = task.state === "in-review";
  const required = task.stampPolicy.required;

  const send = async (command: TaskCommand) => {
    setRefused(undefined);
    const outcome = await onCommand(command);
    if (typeof outcome === "string") setRefused(outcome);
  };

  const addReviewer = () => {
    const reviewer: Reviewer =
      adding === OPERATOR_ADD ? { kind: "operator" } : { kind: "seat", seat: adding as SeatNodeId };
    void send({ kind: "reviewer-add", reviewer });
    setAdding("");
  };

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
          {closed && required === 0 ? null : <ShieldCheck size={13} aria-hidden />}
          {closed ? (
            required === 0 ? null : <output aria-label="Approvals required">{required}</output>
          ) : (
            <>
              <IconButton
                aria-label="Require one fewer approval"
                title="Require one fewer approval"
                disabled={pending || required <= 0}
                onClick={() => void send({ kind: "stamp-policy", required: required - 1 })}
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
                onClick={() => void send({ kind: "stamp-policy", required: required + 1 })}
              >
                <Plus size={12} />
              </IconButton>
            </>
          )}
          <span>{required === 0 ? "no stamps needed" : "approvals needed"}</span>
        </div>
      </header>

      {required > 0 && (inReview || tally.slots.length > required) ? (
        <div className="task-reviewers__tally">
          <StampTally tally={tally} />
        </div>
      ) : null}

      {task.reviewers.length === 0 ? (
        <p className="task-reviewers__empty">
          {closed
            ? "No reviewers."
            : required === 0
              ? "No reviewers. Finishing completes the task."
              : "No reviewers yet. Add a seat to ask for its stamp."}
        </p>
      ) : (
        <ul className="task-reviewers__list">
          {task.reviewers.map((reviewer) => {
            const stamp = stampOf(task, reviewer);
            return (
              <li
                key={reviewerKey(reviewer)}
                data-testid="task-reviewer"
                data-reviewer={reviewerKey(reviewer)}
                data-verdict={stamp?.verdict}
              >
                <strong>{nameOf(reviewer)}</strong>
                <Chip tone={stampTone(stamp)}>{stampWord(stamp, inReview)}</Chip>
                {closed ? null : (
                  <IconButton
                    aria-label={`Remove ${nameOf(reviewer)} as reviewer`}
                    title="Remove reviewer"
                    disabled={pending}
                    onClick={() => void send({ kind: "reviewer-remove", reviewer })}
                  >
                    <X size={12} />
                  </IconButton>
                )}
                {stamp?.text ? <p>{stamp.text}</p> : null}
              </li>
            );
          })}
        </ul>
      )}

      {addOptions.length > 0 ? (
        <div className="task-reviewers__add">
          <Dropdown
            aria-label="Add reviewer"
            value={adding}
            options={addOptions}
            onChange={setAdding}
            placeholder="Add reviewer…"
            disabled={pending}
          />
          <Button size="xs" variant="chrome" disabled={pending || adding === ""} onClick={addReviewer}>
            <Plus size={12} aria-hidden />
            Add
          </Button>
        </div>
      ) : null}

      {stamps.length > 0 ? (
        <div className="task-reviewers__stamp" role="group" aria-label="Your stamp">
          <Button
            size="xs"
            variant="primary"
            disabled={pending}
            data-testid="task-stamp-approve"
            onClick={() => void send({ kind: "stamp", verdict: "approve" })}
          >
            <Check size={12} aria-hidden />
            Approve
          </Button>
          <Button
            size="xs"
            variant="danger"
            disabled={pending}
            data-testid="task-stamp-changes"
            onClick={() => void send({ kind: "stamp", verdict: "changes" })}
          >
            <X size={12} aria-hidden />
            Ask for changes
          </Button>
        </div>
      ) : null}

      {refused === undefined ? null : (
        <p className="task-reviewers__refused" role="alert" data-testid="task-reviewers-refused">
          {refused}
        </p>
      )}
    </section>
  );
}
