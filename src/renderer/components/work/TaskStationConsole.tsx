import { useState } from "react";
import { ArrowUpRight, CheckCircle2, Gavel, Undo2 } from "lucide-react";
import type { ClaimResponse, ClaimWaiver } from "@shared/canvas";
import { evaluateClaimCompletion, type EffectiveClaim } from "@shared/claims";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Dropdown } from "../ui/Dropdown";
import { Input, Textarea } from "../ui/Field";
import "./task-flow.css";

/** A forward station the operator may hand this work to. Forwarding is choose-one. */
export type StationDestination = {
  readonly id: string;
  readonly label: string;
};

/** A visited station offered as a defect target in journey order. */
export type DefectStationTarget = StationDestination & {
  readonly present: boolean;
};

/** What the operator answered at this station, sent with the completion. */
export type StationSubmission = {
  readonly responses: ReadonlyArray<ClaimResponse>;
  readonly waivers: ReadonlyArray<ClaimWaiver>;
  readonly note?: string;
};

type ClaimDraft = {
  readonly response: string;
  readonly refs: string;
  readonly waived: boolean;
  readonly reason: string;
};

const EMPTY_DRAFT: ClaimDraft = {
  response: "",
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

const provenanceChip = (claim: EffectiveClaim): string => {
  switch (claim.provenance.kind) {
    case "region":
      return `in ${claim.provenance.label}`;
    case "sink":
      return "This station";
    case "task":
      return "Task claim";
  }
};

/** Keep the previous-station fast path implicit; name only a deeper target. */
export const explicitDefectTarget = (
  previousStation: string | undefined,
  selectedStation: string,
): string | undefined =>
  selectedStation === previousStation ? undefined : selectedStation;

export function DefectTargetPicker({
  targets,
  selected,
  pending,
  onSelect,
}: {
  readonly targets: ReadonlyArray<DefectStationTarget>;
  readonly selected: string;
  readonly pending: boolean;
  readonly onSelect: (station: string) => void;
}) {
  const selectedTarget = targets.find((target) => target.id === selected);
  return (
    <>
      <details className="task-station-console__defect-targets">
        <summary>
          <span>Return to</span>
          <strong>{selectedTarget?.label ?? "Choose a station"}</strong>
        </summary>
        <fieldset aria-label="Defect target">
          <legend>Visited line</legend>
          {targets.map((target, index) => (
            <label
              key={target.id}
              className="task-station-console__defect-target"
              data-present={target.present ? "true" : "false"}
            >
              <span className="task-station-console__defect-stop" aria-hidden>
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
                  <small>No longer a task station</small>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      </details>
      {selectedTarget ? (
        <p className="task-station-console__defect-consequence">
          {selectedTarget.present ? (
            <>
              Work already accepted before {selectedTarget.label} stays accepted;
              everything from {selectedTarget.label} onward is redone.
            </>
          ) : (
            <>
              {selectedTarget.label} can no longer receive work. Choose another
              visited station.
            </>
          )}
        </p>
      ) : null}
    </>
  );
}

/**
 * Operator console for an operator-owned station: answer the standing claims,
 * then route the work forward, close it, or send it back as a defect. The
 * work service checks the shape of what is submitted here, never its truth.
 */
export function TaskStationConsole({
  claims,
  destinations,
  defectTargets,
  previousStation,
  canSendBack,
  pending,
  onComplete,
  onSendBack,
}: {
  readonly claims: ReadonlyArray<EffectiveClaim>;
  readonly destinations: ReadonlyArray<StationDestination>;
  readonly defectTargets: ReadonlyArray<DefectStationTarget>;
  /** The kernel's unchanged implicit target when no explicit target is sent. */
  readonly previousStation: string | undefined;
  /** Defect-back needs a previous passage to return to. */
  readonly canSendBack: boolean;
  readonly pending: boolean;
  /** Forward when `next` is named, terminal close when it is not. */
  readonly onComplete: (
    submission: StationSubmission,
    next: string | undefined,
  ) => Promise<boolean>;
  readonly onSendBack: (
    summary: string,
    refs: ReadonlyArray<string>,
    note: string,
    target: string | undefined,
  ) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ClaimDraft>>(new Map());
  const [note, setNote] = useState("");
  const [next, setNext] = useState(destinations[0]?.id ?? "");
  const [defectOpen, setDefectOpen] = useState(false);
  const [defectSummary, setDefectSummary] = useState("");
  const [defectRefs, setDefectRefs] = useState("");
  const defaultDefectTarget =
    previousStation ?? defectTargets[defectTargets.length - 1]?.id ?? "";
  const [defectTarget, setDefectTarget] = useState(defaultDefectTarget);
  const selectedDefectTarget = defectTargets.find(
    (target) => target.id === defectTarget,
  );

  const draftFor = (claimId: string): ClaimDraft => drafts.get(claimId) ?? EMPTY_DRAFT;
  const patchDraft = (claimId: string, patch: Partial<ClaimDraft>) =>
    setDrafts((current) => {
      const nextDrafts = new Map(current);
      nextDrafts.set(claimId, { ...draftFor(claimId), ...patch });
      return nextDrafts;
    });

  const responses: ReadonlyArray<ClaimResponse> = claims.flatMap((entry) => {
    const draft = draftFor(entry.claim.id);
    const response = draft.response.trim();
    if (!response) return [];
    const refs = parseRefs(draft.refs);
    return [
      {
        claimId: entry.claim.id,
        response,
        ...(refs.length > 0 ? { refs } : {}),
      },
    ];
  });
  const waivers: ReadonlyArray<ClaimWaiver> = claims.flatMap((entry) => {
    const draft = draftFor(entry.claim.id);
    if (!draft.waived || draft.response.trim()) return [];
    const reason = draft.reason.trim();
    return reason ? [{ claimId: entry.claim.id, reason }] : [];
  });
  const gate = evaluateClaimCompletion({
    stack: claims,
    evidence: {
      artifacts: [],
      ...(responses.length > 0 ? { responses } : {}),
      ...(waivers.length > 0 ? { claimWaivers: waivers } : {}),
    },
  });

  const submission: StationSubmission = {
    responses,
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

  const complete = async (destination: string | undefined) => {
    if (await onComplete(submission, destination)) reset();
  };

  return (
    <section className="task-station-console" aria-label="Operator station">
      <div className="task-station-console__heading">
        <Gavel size={15} aria-hidden />
        <div>
          <p>Operator station</p>
          <h3>Answer the claims, then route the work</h3>
        </div>
      </div>

      {claims.length === 0 ? (
        <p className="task-station-console__empty">
          No standing claims here. Route the work when you are done with it.
        </p>
      ) : (
        <ul className="task-station-console__claims">
          {claims.map((entry) => {
            const draft = draftFor(entry.claim.id);
            const answered = draft.response.trim().length > 0;
            return (
              <li
                key={entry.claim.id}
                className="task-station-claim"
                data-answered={answered ? "true" : "false"}
              >
                <div className="task-station-claim__top">
                  <Chip tone={entry.claim.severity === "hard" ? "amber" : "steel"}>
                    {entry.claim.severity === "hard" ? "Required" : "Optional"}
                  </Chip>
                  <p className="task-station-claim__text">{entry.claim.text}</p>
                </div>
                <p className="task-station-claim__provenance">
                  {provenanceChip(entry)}
                </p>
                <label className="task-station-claim__field">
                  <span>Your answer</span>
                  <Textarea
                    value={draft.response}
                    disabled={pending}
                    placeholder="What did you check, and what did you find?"
                    rows={3}
                    onChange={(event) =>
                      patchDraft(entry.claim.id, { response: event.target.value })
                    }
                  />
                </label>
                <label className="task-station-claim__field">
                  <span>Refs</span>
                  <Input
                    value={draft.refs}
                    disabled={pending}
                    placeholder="artifact names, commits, links…"
                    onChange={(event) =>
                      patchDraft(entry.claim.id, { refs: event.target.value })
                    }
                  />
                </label>
                {entry.claim.severity === "soft" && !answered ? (
                  <>
                    <label className="task-station-claim__waive">
                      <input
                        type="checkbox"
                        checked={draft.waived}
                        disabled={pending}
                        onChange={(event) =>
                          patchDraft(entry.claim.id, { waived: event.target.checked })
                        }
                      />
                      <span>Waive this claim instead</span>
                    </label>
                    {draft.waived ? (
                      <label className="task-station-claim__field">
                        <span>Why waive it</span>
                        <Input
                          value={draft.reason}
                          disabled={pending}
                          placeholder="Reason on record…"
                          onChange={(event) =>
                            patchDraft(entry.claim.id, { reason: event.target.value })
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

      <label className="task-station-console__field">
        <span>
          {destinations.length > 0 ? "Note carried forward" : "Closing note"}
        </span>
        <Textarea
          value={note}
          disabled={pending}
          placeholder={
            destinations.length > 0
              ? "What the next station should know…"
              : "What closed this…"
          }
          rows={3}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {gate ? (
        <p className="task-station-console__empty" role="status">
          {gate.message}
        </p>
      ) : null}

      <div className="task-station-console__actions">
        {destinations.length > 1 ? (
          <Dropdown
            value={next}
            options={destinations.map((destination) => ({
              value: destination.id,
              label: destination.label,
            }))}
            disabled={pending}
            aria-label="Forward destination"
            placeholder="Choose a station…"
            className="task-station-console__destination"
            align="start"
            onChange={setNext}
          />
        ) : null}
        {destinations.length > 0 ? (
          <Button
            size="sm"
            variant="primary"
            disabled={pending || gate !== undefined || !next}
            data-testid="task-station-forward"
            title="Hand this work to the next station"
            onClick={() => void complete(next)}
          >
            <ArrowUpRight size={13} />
            {destinations.length === 1
              ? `Forward to ${destinations[0]?.label}`
              : "Forward"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={pending || gate !== undefined}
            data-testid="task-station-close"
            title="Close this work here"
            onClick={() => void complete(undefined)}
          >
            <CheckCircle2 size={13} />
            Close task
          </Button>
        )}
        {canSendBack ? (
          <Button
            size="sm"
            variant="subtle"
            disabled={pending}
            data-testid="task-station-defect-open"
            onClick={() => setDefectOpen((open) => !open)}
          >
            <Undo2 size={13} />
            {defectOpen ? "Keep it here" : "Send back"}
          </Button>
        ) : null}
      </div>

      {defectOpen && canSendBack ? (
        <div className="task-station-console__defect">
          <DefectTargetPicker
            targets={defectTargets}
            selected={defectTarget}
            pending={pending}
            onSelect={setDefectTarget}
          />
          <label className="task-station-console__field">
            <span>Defect</span>
            <Textarea
              value={defectSummary}
              disabled={pending}
              placeholder="What is wrong, and what would make it right?"
              rows={3}
              onChange={(event) => setDefectSummary(event.target.value)}
            />
          </label>
          <label className="task-station-console__field">
            <span>Refs</span>
            <Input
              value={defectRefs}
              disabled={pending}
              placeholder="artifact names, commits, links…"
              onChange={(event) => setDefectRefs(event.target.value)}
            />
          </label>
          <div className="task-station-console__actions">
            <Button
              size="sm"
              variant="danger"
              disabled={
                pending ||
                !defectSummary.trim() ||
                !selectedDefectTarget?.present
              }
              data-testid="task-station-defect-send"
              title={
                selectedDefectTarget
                  ? `Return this work to ${selectedDefectTarget.label}`
                  : "Choose a station to return this work to"
              }
              onClick={async () => {
                if (
                  await onSendBack(
                    defectSummary.trim(),
                    parseRefs(defectRefs),
                    note.trim(),
                    explicitDefectTarget(previousStation, defectTarget),
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
