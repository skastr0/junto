import { useState } from "react";
import { ArrowUpRight, CheckCircle2, Gavel, Undo2 } from "lucide-react";
import type { Claim, Waiver } from "@shared/work-model";
import { evaluateRules, type RuleInForce } from "@shared/rules";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { Input, Textarea } from "../ui/Field";
import "./task-path.css";

/** One Next board the operator may send this task on to. */
export type NextBoard = {
  readonly id: string;
  readonly label: string;
};

/** A visited board offered as a defect target in visit order. */
export type DefectBoardTarget = NextBoard & {
  readonly present: boolean;
};

/** What the operator answered at this board, sent with the completion. */
export type RuleSubmission = {
  readonly claims: ReadonlyArray<Claim>;
  readonly waivers: ReadonlyArray<Waiver>;
  readonly note?: string;
};

type RuleDraft = {
  readonly answer: string;
  readonly refs: string;
  readonly waived: boolean;
  readonly reason: string;
};

const EMPTY_DRAFT: RuleDraft = {
  answer: "",
  refs: "",
  waived: false,
  reason: "",
};

/** Refs are typed the way task artifact names are: commas or new lines. */
const parseRefs = (text: string): ReadonlyArray<string> =>
  text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const provenanceChip = (rule: RuleInForce): string => {
  switch (rule.provenance.kind) {
    case "region":
      return `in ${rule.provenance.label}`;
    case "board":
      return "This board";
    case "task":
      return "Task rule";
  }
};

/** Keep the previous-board fast path implicit; name only a deeper target. */
export const explicitDefectTarget = (
  previousBoard: string | undefined,
  selectedBoard: string,
): string | undefined =>
  selectedBoard === previousBoard ? undefined : selectedBoard;

export function DefectTargetPicker({
  targets,
  selected,
  pending,
  onSelect,
}: {
  readonly targets: ReadonlyArray<DefectBoardTarget>;
  readonly selected: string;
  readonly pending: boolean;
  readonly onSelect: (board: string) => void;
}) {
  const selectedTarget = targets.find((target) => target.id === selected);
  return (
    <>
      <details className="task-operator-panel__defect-targets">
        <summary>
          <span>Return to</span>
          <strong>{selectedTarget?.label ?? "Choose a board"}</strong>
        </summary>
        <fieldset aria-label="Defect target">
          <legend>Visited boards</legend>
          {targets.map((target, index) => (
            <label
              key={target.id}
              className="task-operator-panel__defect-target"
              data-present={target.present ? "true" : "false"}
            >
              <span className="task-operator-panel__defect-order" aria-hidden>
                {index + 1}
              </span>
              <input
                type="radio"
                name="defect-target"
                value={target.id}
                checked={target.id === selected}
                disabled={pending || !target.present}
                onChange={() => onSelect(target.id)}
              />
              <span>
                <strong>{target.label}</strong>
                {!target.present ? (
                  <small>No longer a Tasks board</small>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      </details>
      {selectedTarget ? (
        <p className="task-operator-panel__defect-consequence">
          {selectedTarget.present ? (
            <>
              Work already accepted before {selectedTarget.label} stays accepted;
              everything from {selectedTarget.label} onward is redone.
            </>
          ) : (
            <>
              {selectedTarget.label} can no longer receive work. Choose another
              visited board.
            </>
          )}
        </p>
      ) : null}
    </>
  );
}

/**
 * Operator panel for an operator-admission board: answer the rules in force,
 * then send the task on, complete it here, or send it back as a defect. The
 * work service checks the shape of what is submitted here, never its truth.
 */
export function TaskOperatorPanel({
  rules,
  nextBoards,
  defectTargets,
  previousBoard,
  canSendBack,
  pending,
  waivable,
  onComplete,
  onSendBack,
}: {
  readonly rules: ReadonlyArray<RuleInForce>;
  readonly nextBoards: ReadonlyArray<NextBoard>;
  readonly defectTargets: ReadonlyArray<DefectBoardTarget>;
  /** The kernel's unchanged implicit target when no explicit target is sent. */
  readonly previousBoard: string | undefined;
  /** Sending back needs a previous visit to return to. */
  readonly canSendBack: boolean;
  readonly pending: boolean;
  /** True when a rule may be fork-waived for the chosen next board. */
  readonly waivable: (ruleId: string, next: string | undefined) => boolean;
  /** Send on when `next` is named; complete here when it is not. */
  readonly onComplete: (
    submission: RuleSubmission,
    next: string | undefined,
  ) => Promise<boolean>;
  readonly onSendBack: (
    summary: string,
    refs: ReadonlyArray<string>,
    note: string,
    target: string | undefined,
  ) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, RuleDraft>>(new Map());
  const [note, setNote] = useState("");
  const [next, setNext] = useState(nextBoards[0]?.id ?? "");
  const [defectOpen, setDefectOpen] = useState(false);
  const [defectSummary, setDefectSummary] = useState("");
  const [defectRefs, setDefectRefs] = useState("");
  const defaultDefectTarget =
    previousBoard ?? defectTargets[defectTargets.length - 1]?.id ?? "";
  const [defectTarget, setDefectTarget] = useState(defaultDefectTarget);
  const selectedDefectTarget = defectTargets.find(
    (target) => target.id === defectTarget,
  );

  const draftFor = (ruleId: string): RuleDraft => drafts.get(ruleId) ?? EMPTY_DRAFT;
  const patchDraft = (ruleId: string, patch: Partial<RuleDraft>) =>
    setDrafts((current) => {
      const nextDrafts = new Map(current);
      nextDrafts.set(ruleId, { ...draftFor(ruleId), ...patch });
      return nextDrafts;
    });

  const claims: ReadonlyArray<Claim> = rules.flatMap((entry) => {
    const draft = draftFor(entry.rule.id);
    const text = draft.answer.trim();
    if (!text) return [];
    const refs = parseRefs(draft.refs);
    return [{ ruleId: entry.rule.id, text, ...(refs.length > 0 ? { refs } : {}) }];
  });
  const waivers: ReadonlyArray<Waiver> = rules.flatMap((entry) => {
    const draft = draftFor(entry.rule.id);
    if (!draft.waived || draft.answer.trim()) return [];
    const reason = draft.reason.trim();
    return reason ? [{ ruleId: entry.rule.id, reason }] : [];
  });
  const gate = evaluateRules({
    rules,
    evidence: {
      artifacts: [],
      ...(claims.length > 0 ? { claims } : {}),
      ...(waivers.length > 0 ? { waivers } : {}),
    },
  });

  const submission: RuleSubmission = {
    claims,
    waivers,
    ...(note.trim() ? { note: note.trim() } : {}),
  };

  const reset = () => {
    setDrafts(new Map());
    setNote("");
    setDefectOpen(false);
    setDefectSummary("");
    setDefectRefs("");
    setDefectTarget(defaultDefectTarget);
  };

  const complete = async (nextBoard: string | undefined) => {
    if (await onComplete(submission, nextBoard)) reset();
  };

  return (
    <section className="task-operator-panel" aria-label="Operator panel">
      <div className="task-operator-panel__heading">
        <Gavel size={15} aria-hidden />
        <div>
          <p>Operator panel</p>
          <h3>Answer the rules, then complete the task</h3>
        </div>
      </div>

      {rules.length === 0 ? (
        <p className="task-operator-panel__empty">
          No rules in force here. Complete the task when you are done with it.
        </p>
      ) : (
        <ul className="task-operator-panel__rules">
          {rules.map((entry) => {
            const draft = draftFor(entry.rule.id);
            const answered = draft.answer.trim().length > 0;
            const canWaive = waivable(entry.rule.id, next);
            return (
              <li
                key={entry.rule.id}
                className="task-operator-rule"
                data-answered={answered ? "true" : "false"}
              >
                <div className="task-operator-rule__top">
                  <p className="task-operator-rule__text">{entry.rule.text}</p>
                </div>
                <p className="task-operator-rule__provenance">
                  {provenanceChip(entry)}
                </p>
                <label className="task-operator-rule__field">
                  <span>Your answer</span>
                  <Textarea
                    value={draft.answer}
                    disabled={pending}
                    placeholder="What did you check, and what did you find?"
                    rows={3}
                    onChange={(event) =>
                      patchDraft(entry.rule.id, { answer: event.target.value })
                    }
                  />
                </label>
                <label className="task-operator-rule__field">
                  <span>Refs</span>
                  <Input
                    value={draft.refs}
                    disabled={pending}
                    placeholder="artifact names, commits, links…"
                    onChange={(event) =>
                      patchDraft(entry.rule.id, { refs: event.target.value })
                    }
                  />
                </label>
                {canWaive && !answered ? (
                  <>
                    <label className="task-operator-rule__waive">
                      <input
                        type="checkbox"
                        checked={draft.waived}
                        disabled={pending}
                        onChange={(event) =>
                          patchDraft(entry.rule.id, { waived: event.target.checked })
                        }
                      />
                      <span>Waive because this path no longer reaches its board</span>
                    </label>
                    {draft.waived ? (
                      <label className="task-operator-rule__field">
                        <span>Why waive it</span>
                        <Input
                          value={draft.reason}
                          disabled={pending}
                          placeholder="Reason on record…"
                          onChange={(event) =>
                            patchDraft(entry.rule.id, { reason: event.target.value })
                          }
                        />
                      </label>
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <label className="task-operator-panel__field">
        <span>
          {nextBoards.length > 0 ? "Handoff note" : "Completion note"}
        </span>
        <Textarea
          value={note}
          disabled={pending}
          placeholder={
            nextBoards.length > 0
              ? "What the next board should know…"
              : "What completed this…"
          }
          rows={3}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {gate ? (
        <p className="task-operator-panel__empty" role="status">
          {gate.message}
        </p>
      ) : null}

      <div className="task-operator-panel__actions">
        {nextBoards.length > 1 ? (
          <Dropdown
            value={next}
            options={nextBoards.map((board) => ({
              value: board.id,
              label: board.label,
            }))}
            disabled={pending}
            aria-label="Next board"
            placeholder="Choose a board…"
            className="task-operator-panel__next"
            align="start"
            onChange={setNext}
          />
        ) : null}
        {nextBoards.length > 0 ? (
          <Button
            size="sm"
            variant="primary"
            disabled={pending || gate !== undefined || !next}
            data-testid="task-operator-send-on"
            title="Send this work to the next board"
            onClick={() => void complete(next)}
          >
            <ArrowUpRight size={13} />
            {nextBoards.length === 1
              ? `Send on to ${nextBoards[0]?.label}`
              : "Send on"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={pending || gate !== undefined}
            data-testid="task-operator-close"
            title="Complete this task here"
            onClick={() => void complete(undefined)}
          >
            <CheckCircle2 size={13} />
            Complete task
          </Button>
        )}
        {canSendBack ? (
          <Button
            size="sm"
            variant="subtle"
            disabled={pending}
            data-testid="task-operator-defect-open"
            onClick={() => setDefectOpen((open) => !open)}
          >
            <Undo2 size={13} />
            {defectOpen ? "Keep it here" : "Send back"}
          </Button>
        ) : null}
      </div>

      {defectOpen && canSendBack ? (
        <div className="task-operator-panel__defect">
          <DefectTargetPicker
            targets={defectTargets}
            selected={defectTarget}
            pending={pending}
            onSelect={setDefectTarget}
          />
          <label className="task-operator-panel__field">
            <span>Defect</span>
            <Textarea
              value={defectSummary}
              disabled={pending}
              placeholder="What is wrong, and what would make it right?"
              rows={3}
              onChange={(event) => setDefectSummary(event.target.value)}
            />
          </label>
          <label className="task-operator-panel__field">
            <span>Refs</span>
            <Input
              value={defectRefs}
              disabled={pending}
              placeholder="artifact names, commits, links…"
              onChange={(event) => setDefectRefs(event.target.value)}
            />
          </label>
          <div className="task-operator-panel__actions">
            <Button
              size="sm"
              variant="danger"
              disabled={
                pending ||
                !defectSummary.trim() ||
                !selectedDefectTarget?.present
              }
              data-testid="task-operator-defect-send"
              title={
                selectedDefectTarget
                  ? `Return this work to ${selectedDefectTarget.label}`
                  : "Choose a board to return this work to"
              }
              onClick={async () => {
                if (
                  await onSendBack(
                    defectSummary.trim(),
                    parseRefs(defectRefs),
                    note.trim(),
                    explicitDefectTarget(previousBoard, defectTarget),
                  )
                ) {
                  reset();
                }
              }}
            >
              <Undo2 size={13} />
              Send back as a defect
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
