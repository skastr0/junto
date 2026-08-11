/**
 * Stack of completed-task notifications above the notify / minimap cluster.
 * Click focuses the tasks node, opens the board with the task selected, and
 * durably dismisses this entry.
 *
 * Visual: boundless card stack only — no plate chrome, no "completed" copy.
 * Each card is icon + brief; the list scrolls without mid-card clip.
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

export function CompletedTaskNotifyStack() {
  const doc = use$(state$.doc);
  const items = use$(completedTaskNotify$.items);

  useEffect(() => {
    syncCompletedTaskNotifyFromDoc(doc.nodes);
  }, [doc]);

  if (items.length === 0) return null;

  return (
    <div
      className="completed-task-notify"
      role="region"
      aria-label="Finished tasks"
      data-testid="completed-task-notify"
    >
      <div className="completed-task-notify__list">
        {items.map((item) => (
          <CompletedTaskNotifyCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function CompletedTaskNotifyCard({ item }: { readonly item: CompletedTaskNotifyItem }) {
  return (
    <button
      type="button"
      className="completed-task-notify__item"
      title={`${item.brief} — open task`}
      aria-label={`Open finished task: ${item.brief}`}
      onClick={() => activateCompletedTaskNotify(item)}
    >
      <CheckCircle2 size={15} className="completed-task-notify__icon" aria-hidden />
      <span className="completed-task-notify__brief">{item.brief}</span>
    </button>
  );
}
