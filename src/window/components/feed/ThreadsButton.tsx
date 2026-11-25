/**
 * The top bar's Threads button: the operator's threads with every seat, and
 * how many have something unread. Pressing it opens Global threads, or closes
 * it when it is open, the same as its key (threads.open): the panel and its dim
 * start under the bar, so the bar stays live and this button gets the press.
 *
 * The icon stays steel: amber on an icon belongs to Needs you. The count is
 * the same pill the feed's button wears (one colour, one meaning, unread; an
 * unread thread is not blocked): how many threads on the canvas have mail the
 * operator has not read. It is not a need, so it
 * never counts into Needs you. The button says nothing as the count changes:
 * the feed and Global threads say what arrived.
 */
import { use$ } from "@legendapp/state/react";
import { MessagesSquare } from "lucide-react";
import { keyAria, keyCaps } from "../../lib/key-match";
import { operatorModal$, toggleOperatorModal } from "../../lib/operator-modal";
import { useOperatorThreads } from "../../lib/operator-threads";
import { isMac } from "../../lib/platform";
import { state$ } from "../../lib/state";
import "./operator-feed.css";

export function ThreadsButton() {
  const canvasName = use$(state$.canvasName);
  // Threads with mail the operator has not read: the rows Global threads lists under its Unread filter, watched live.
  // Not `.unread`, which counts mails. The rule is the core's (product-attention); the button marks nothing read.
  const unread = useOperatorThreads({ canvasName, unread: true }).total;
  const open = use$(operatorModal$.open) === "threads";
  const chord = keyCaps("threads.open")?.join(isMac() ? "" : "+");
  return (
    <button
      type="button"
      className="station-icon-button operator-feed-trigger"
      data-testid="threads-trigger"
      aria-label={unread === 0 ? "Threads, nothing unread" : `Threads, ${unread} unread`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts={keyAria("threads.open")}
      title={chord === undefined ? "Threads" : `Threads (${chord})`}
      style={{ borderColor: "var(--color-stroke)", color: "var(--color-steel)" }}
      onClick={() => toggleOperatorModal("threads")}
    >
      <MessagesSquare size={15} />
      {unread > 0 ? (
        <span className="operator-feed-trigger__count" aria-hidden>
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </button>
  );
}
