import { Gavel } from "lucide-react";
import { Chip, type ChipTone } from "../ui";
import {
  mailEvidenceLabel,
} from "../../lib/crew-mail-view";
import {
  reviewSubjectLabel,
  reviewVerdictLabel,
  type ReviewGate,
  type ReviewVerdict,
} from "../../lib/crew-review-view";
import "./verdict-chain.css";

const verdictTone = (kind: ReviewVerdict["kind"]): ChipTone =>
  kind === "green" ? "green" : "crimson";

const formatTime = (timeMs: number | undefined): string =>
  timeMs === undefined
    ? "Time unavailable"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timeMs);

export function VerdictChain({
  verdicts,
  gate,
}: {
  readonly verdicts: ReadonlyArray<ReviewVerdict>;
  readonly gate: ReviewGate;
}) {
  return (
    <section className="verdict-chain" data-testid="verdict-chain" aria-label="Verdict chain">
      <header className="verdict-chain__heading">
        <div>
          <span>Review record</span>
          <h3>
            <Gavel size={13} aria-hidden />
            Verdicts
          </h3>
        </div>
        <span>
          {verdicts.length === 0
            ? "none yet"
            : `${verdicts.length} ${verdicts.length === 1 ? "verdict" : "verdicts"}`}
        </span>
      </header>
      {verdicts.length === 0 ? (
        <p className="verdict-chain__empty">
          {gate.required
            ? "No verdicts on this epoch yet."
            : "No verdicts recorded."}
        </p>
      ) : (
        <ol className="verdict-chain__list">
          {verdicts.map((verdict) => {
            const current = verdict.epoch === gate.currentEpoch;
            return (
              <li
                key={verdict.verdictId}
                className="verdict-chain__entry"
                data-testid="verdict-chain-entry"
                data-verdict={verdict.kind}
                data-epoch={String(verdict.epoch)}
                data-current={current ? "true" : "false"}
              >
                <div className="verdict-chain__entry-head">
                  <strong className="verdict-chain__reviewer">
                    {verdict.reviewerLabel}
                  </strong>
                  <Chip tone={verdictTone(verdict.kind)}>
                    {reviewVerdictLabel(verdict.kind)}
                  </Chip>
                  <Chip tone={current ? "amber" : "steel"}>
                    {reviewSubjectLabel(verdict.subject)}
                  </Chip>
                  {!current ? (
                    <span className="verdict-chain__stale">prior epoch</span>
                  ) : null}
                  <time
                    className="verdict-chain__time"
                    dateTime={
                      verdict.postedAtMs === undefined
                        ? undefined
                        : new Date(verdict.postedAtMs).toISOString()
                    }
                  >
                    {formatTime(verdict.postedAtMs)}
                  </time>
                </div>
                {verdict.findings.length > 0 ? (
                  <ul className="verdict-chain__findings">
                    {verdict.findings.map((finding, index) => (
                      <li key={`${verdict.verdictId}-finding-${index}`}>{finding}</li>
                    ))}
                  </ul>
                ) : null}
                {verdict.refs.length > 0 ? (
                  <ul className="verdict-chain__refs">
                    {verdict.refs.map((ref, index) => (
                      <li key={`${verdict.verdictId}-ref-${index}`}>
                        {mailEvidenceLabel(ref)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
