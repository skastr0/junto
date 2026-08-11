/**
 * Stack of completed-task notifications above the notify / minimap cluster.
 * Click focuses the tasks node, opens the board with the task selected, and
 * durably dismisses this entry (survives remount / restart).
 *
 * Visual: solid raise plate with a chrome header so the stack never dissolves
 * into the canvas; list scrolls with full-card steps (no mid-card clip).
 */
import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import { CheckCircle2 } from "lucide-react";
import {
  activateCompletedTaskNotify,
  completedTaskNotify$,
  syncCompletedTaskNotifyFromDoc,
  type CompletedTaskNotifyItem,
} from "../../lib/completed-task-notify";
import { state$ } from "../../lib/state";

/** Soft cap for on-screen cards; remainder summarized so the plate stays bounded. */
const VISIBLE_CAP = 6;

export function CompletedTaskNotifyStack() {
  const doc = use$(state$.doc);
  const items = use$(completedTaskNotify$.items);

  useEffect(() => {
    syncCompletedTaskNotifyFromDoc(doc.nodes);
  }, [doc]);

  if (items.length === 0) return null;

  const visible = items.slice(0, VISIBLE_CAP);
  const overflow = items.length - visible.length;

  return (
    <div
      className="completed-task-notify"
      role="region"
      aria-label="Completed tasks"
      data-testid="completed-task-notify"
    >
      <div className="completed-task-notify__chrome">
        <span className="completed-task-notify__chrome-label">completed</span>
        <span className="completed-task-notify__chrome-count" aria-live="polite">
          {items.length}
        </span>
      </div>
      <div className="completed-task-notify__list">
        {visible.map((item) => (
          <CompletedTaskNotifyCard key={item.id} item={item} />
        ))}
      </div>
      {overflow > 0 ? (
        <div className="completed-task-notify__more" aria-label={`${overflow} more completed`}>
          +{overflow} more — open the tasks board
        </div>
      ) : null}
    </div>
  );
}

function CompletedTaskNotifyCard({ item }: { readonly item: CompletedTaskNotifyItem }) {
  return (
    <button
      type="button"
      className="completed-task-notify__item"
      title={`${item.brief} — open task`}
      aria-label={`Completed: ${item.brief}. Open task board.`}
      onClick={() => activateCompletedTaskNotify(item)}
    >
      <CheckCircle2 size={14} className="completed-task-notify__icon" aria-hidden />
      <span className="completed-task-notify__body">
        <span className="completed-task-notify__eyebrow">completed</span>
        <span className="completed-task-notify__brief">{item.brief}</span>
      </span>
    </button>
  );
}
