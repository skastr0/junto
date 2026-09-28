/**
 * The top-right inbox: a count on the bar and, pressed, a short list of
 * everyone who needs the operator, newest first, the way notifications read.
 * A row goes to its seat: selects it and brings it into view. Answering in
 * place stays in the full feed (⌘I), one link away.
 */
import { useState } from "react";
import { use$ } from "@legendapp/state/react";
import { ArrowUpRight, Boxes, Inbox } from "lucide-react";
import { mailAgeLabel } from "../../lib/actor-ledger";
import { NEEDS_YOU_LABEL, useNeedsYou, type NeedsYouEntry } from "../../lib/needs-you-inbox";
import { openOperatorFeed, operatorFeed$ } from "../../lib/operator-feed";
import { modKeyGlyph } from "../../lib/platform";
import { selectNode, state$ } from "../../lib/state";
import { useHealthClock } from "../../lib/thread-health";
import { AgentPortrait } from "../AgentPortrait";
import { Popover } from "../ui";
import "./operator-feed.css";

const goToSeat = (entry: NeedsYouEntry, close: () => void): void => {
  close();
  selectNode(entry.nodeId);
  state$.focusNodeId.set(entry.nodeId);
};

function InboxRow({ entry, nowMs, onPick }: { readonly entry: NeedsYouEntry; readonly nowMs: number; readonly onPick: () => void }) {
  const label = NEEDS_YOU_LABEL[entry.kind];
  const age = mailAgeLabel(nowMs, entry.since);
  return (
    <li>
      <button
        type="button"
        className="needs-you__row"
        data-testid="needs-you-row"
        data-kind={entry.kind}
        data-node-id={entry.nodeId}
        aria-label={`${entry.name}, ${label}: ${entry.text}. Go to seat.`}
        onClick={onPick}
      >
        <span className="needs-you__portrait" aria-hidden>
          {entry.portraitIdentity ? (
            <AgentPortrait identity={entry.portraitIdentity} size={28} frame="round" outline={false} badge={false} />
          ) : (
            <Boxes size={14} strokeWidth={1.75} />
          )}
        </span>
        <span className="needs-you__body">
          <span className="needs-you__head">
            <span className="needs-you__name">{entry.name}</span>
            <span className={`needs-you__kind needs-you__kind--${entry.kind}`}>{label}</span>
            {age ? (
              <time className="needs-you__age" title={new Date(entry.since).toLocaleString()}>
                {age}
              </time>
            ) : null}
          </span>
          <span className="needs-you__text">{entry.text}</span>
        </span>
      </button>
    </li>
  );
}

export function NeedsYouInbox() {
  const { entries } = useNeedsYou();
  const feedOpen = use$(operatorFeed$.open);
  const nowMs = useHealthClock();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const count = entries.length;
  const blocked = entries.some((entry) => entry.kind === "blocked");
  const label = count === 0 ? "Open needs-you feed, nothing waiting" : `Open needs-you feed, ${count} waiting`;
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="station-icon-button operator-feed-trigger"
        data-testid="operator-feed-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Needs you (${modKeyGlyph()}I for the full feed)`}
        style={{ borderColor: "var(--color-stroke)", color: count > 0 ? "var(--color-amber)" : "var(--color-steel)" }}
        onClick={() => setOpen((current) => !current)}
      >
        <Inbox size={15} />
        {count > 0 ? (
          <span className={`operator-feed-trigger__count${blocked ? " operator-feed-trigger__count--blocked" : ""}`} aria-hidden>
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
      {open && anchor && !feedOpen ? (
        <Popover anchor={anchor} onClose={close} label="Needs you" sides={["below"]} align="end" width={360} className="needs-you" testId="needs-you-inbox">
          <header className="needs-you__top">
            <span className="needs-you__title">Needs you</span>
            <span className="needs-you__count">{count === 0 ? "all clear" : `${count} waiting`}</span>
          </header>
          {count === 0 ? (
            <p className="needs-you__empty" role="status">
              Nobody needs you right now. Blocked agents and questions for you land here.
            </p>
          ) : (
            <ul className="needs-you__list" aria-label="Needs you, newest first">
              {entries.map((entry) => (
                <InboxRow key={entry.id} entry={entry} nowMs={nowMs} onPick={() => goToSeat(entry, close)} />
              ))}
            </ul>
          )}
          <button
            type="button"
            className="needs-you__full"
            onClick={() => {
              close();
              openOperatorFeed();
            }}
          >
            Answer in the full feed
            <span className="needs-you__kbd">{modKeyGlyph()}I</span>
            <ArrowUpRight size={11} aria-hidden />
          </button>
        </Popover>
      ) : null}
    </>
  );
}
