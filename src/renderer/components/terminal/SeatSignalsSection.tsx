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
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { modKeyGlyph } from "../../lib/platform";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { Button, Chip, IconButton, Popover, SidebarSection } from "../ui";
import { Textarea } from "../ui/Field";

// Stable callback ref: the reply field takes focus when the popover opens.
const claimReplyFocus = (wrapper: HTMLDivElement | null): void => {
  claimFocusOnMount(wrapper?.querySelector("textarea") ?? null);
};

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
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const open = signal.state === "open";
  const canSend = open && !pending && reply.trim().length > 0;
  const age = mailAgeLabel(nowMs, signal.createdAt);

  const act = async (run: () => Promise<SignalActionResult>): Promise<void> => {
    setPending(true);
    setError("");
    try {
      const result = await run();
      if (result.ok) onClose();
      else setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const send = (): void => {
    if (canSend) void act(() => respond(signal.signalId, reply.trim()));
  };

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
        <div ref={claimReplyFocus} className="seat-signal-popover__reply">
          <Textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
              event.preventDefault();
              send();
            }}
            placeholder="Reply to the agent…"
            rows={3}
            aria-label="Your reply"
            aria-keyshortcuts="Meta+Enter Control+Enter"
          />
          {error ? <p className="seat-signal-popover__error" role="alert">{error}</p> : null}
          <div className="seat-signal-popover__actions">
            <Button size="xs" variant="subtle" disabled={pending} onClick={() => void act(() => dismiss(signal.signalId))}>
              Dismiss
            </Button>
            <Button size="xs" variant="primary" disabled={!canSend} title={`${modKeyGlyph()}+↵`} onClick={send}>
              Send reply
            </Button>
          </div>
        </div>
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
