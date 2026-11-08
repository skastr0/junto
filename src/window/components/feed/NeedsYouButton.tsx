/**
 * The top bar's needs-you button: the icon and the one count of what needs
 * the operator. Pressing it opens the needs-you feed, or closes it when it is
 * already open, the same as ⌘I.
 */
import { use$ } from "@legendapp/state/react";
import { Inbox } from "lucide-react";
import { feedItemsInOrder, useOperatorFeed } from "../../lib/operator-feed";
import { operatorModal$, toggleOperatorModal } from "../../lib/operator-modal";
import { modKeyGlyph } from "../../lib/platform";
import "./operator-feed.css";

export function NeedsYouButton() {
  const feed = useOperatorFeed();
  const open = use$(operatorModal$.open) === "feed";
  const count = feed.count;
  const blocked = feedItemsInOrder(feed.sections).some((item) => item.kind === "blocked");
  return (
    <button
      type="button"
      className="station-icon-button operator-feed-trigger"
      data-testid="operator-feed-trigger"
      aria-label={count === 0 ? "Needs you, nothing waiting" : `Needs you, ${count}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`Needs you (${modKeyGlyph()}I)`}
      style={{ borderColor: "var(--color-stroke)", color: count > 0 ? "var(--color-amber)" : "var(--color-steel)" }}
      onClick={() => toggleOperatorModal("feed")}
    >
      <Inbox size={15} />
      {count > 0 ? (
        <span className={`operator-feed-trigger__count${blocked ? " operator-feed-trigger__count--blocked" : ""}`} aria-hidden>
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}
