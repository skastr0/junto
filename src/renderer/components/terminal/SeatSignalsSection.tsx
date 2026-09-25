/**
 * Signals section of the seat sidebar: what this agent declared it needs from
 * the operator (blocked, escalate, feedback), open first. A row opens a
 * popover to answer it; the answer is delivered to the seat as operator mail.
 *
 * Declared signals only. Thread health is an AI reading and renders apart.
 */
import { useState } from "react";
import { X } from "lucide-react";
import type { AgentSignal } from "@shared/agent-signals";
import { mailAgeLabel } from "../../lib/actor-ledger";
import {
  SIGNAL_KIND_LABEL,
  SIGNAL_KIND_TONE,
  SIGNALS_SECTION,
  signalOutcomeLabel,
  type SeatSignalSummary,
  type SignalActionResult,
} from "../../lib/agent-signals-view";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { Chip, IconButton, Popover, SidebarSection } from "../ui";
import { SignalReply } from "../signals/SignalReply";

function SignalPopover({
  signal,
  anchor,
  nowMs,
  onClose,
  respond,
  dismiss,
}: {
  readonly signal: AgentSignal;
  readonly anchor: HTMLElement;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly respond: (signalId: string, text: string) => Promise<SignalActionResult>;
  readonly dismiss: (signalId: string) => Promise<SignalActionResult>;
}) {
  const open = signal.state === "open";
  const age = mailAgeLabel(nowMs, signal.createdAt);

  return (
    <Popover anchor={anchor} onClose={onClose} label={`${SIGNAL_KIND_LABEL[signal.kind]} signal`} testId="seat-signal-popover">
      <header className="seat-signal-popover__head">
        <Chip tone={SIGNAL_KIND_TONE[signal.kind]}>{SIGNAL_KIND_LABEL[signal.kind]}</Chip>
        {age ? <span className="seat-signal-popover__age">{age} ago</span> : null}
        {!open ? <span className="seat-signal-popover__age">{signalOutcomeLabel(signal)}</span> : null}
        <IconButton size="sm" className="seat-signal-popover__close" title="Close (Esc)" aria-label="Close signal" onClick={onClose}>
          <X size={13} strokeWidth={1.75} />
        </IconButton>
      </header>
      <p className="seat-signal-popover__text">{signal.text}</p>
      {signal.detail ? (
        <div className="seat-signal-popover__detail">
          <ArtifactMarkdown source={signal.detail} />
        </div>
      ) : null}
      {signal.response ? (
        <div className="seat-signal-popover__response">
          <span className="seat-signal-popover__response-label">your reply</span>
          {signal.response.text}
        </div>
      ) : null}
      {open ? (
        <SignalReply signalId={signal.signalId} respond={respond} dismiss={dismiss} onDone={onClose} />
      ) : null}
    </Popover>
  );
}

export function SeatSignalsSection({
  nodeId,
  summary,
  nowMs,
  respond,
  dismiss,
}: {
  readonly nodeId: string;
  readonly summary: SeatSignalSummary;
  readonly nowMs: number;
  readonly respond: (signalId: string, text: string) => Promise<SignalActionResult>;
  readonly dismiss: (signalId: string) => Promise<SignalActionResult>;
}) {
  const [active, setActive] = useState<{ readonly signalId: string; readonly anchor: HTMLElement } | null>(null);
  const activeSignal = active ? summary.signals.find((signal) => signal.signalId === active.signalId) : undefined;
  const tone = summary.worstOpen === "blocked" ? "crimson" : summary.openCount > 0 ? "amber" : "faint";

  return (
    <SidebarSection
      storageKey="seat-sidebar:signals"
      sectionKey={SIGNALS_SECTION}
      revealFor={nodeId}
      title="signals"
      count={summary.openCount}
      countTone={tone}
      meta={summary.openCount === 0 ? `${summary.signals.length} closed` : undefined}
      testId="seat-signals"
    >
      <ul className="actor-ledger__list">
        {summary.signals.map((signal) => {
          const age = mailAgeLabel(nowMs, signal.createdAt);
          const outcome = signalOutcomeLabel(signal);
          return (
            <li
              key={signal.signalId}
              className={`actor-ledger__item${signal.state === "open" ? "" : " seat-signal--closed"}`}
              data-testid="seat-signal-row"
              data-signal-id={signal.signalId}
              data-signal-state={signal.state}
            >
              <button
                type="button"
                className="actor-ledger__item-row"
                aria-haspopup="dialog"
                aria-expanded={active?.signalId === signal.signalId}
                onClick={(event) => {
                  const anchor = event.currentTarget;
                  setActive((current) => (current?.signalId === signal.signalId ? null : { signalId: signal.signalId, anchor }));
                }}
              >
                <span className="actor-ledger__item-head">
                  <Chip tone={SIGNAL_KIND_TONE[signal.kind]}>{SIGNAL_KIND_LABEL[signal.kind]}</Chip>
                  {outcome ? <span className="actor-ledger__item-detail">{outcome}</span> : null}
                  {age ? <span className="seat-signal__age">{age}</span> : null}
                </span>
                <span className="actor-ledger__item-title">{signal.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {active && activeSignal ? (
        <SignalPopover
          key={activeSignal.signalId}
          signal={activeSignal}
          anchor={active.anchor}
          nowMs={nowMs}
          onClose={() => setActive(null)}
          respond={respond}
          dismiss={dismiss}
        />
      ) : null}
    </SidebarSection>
  );
}
