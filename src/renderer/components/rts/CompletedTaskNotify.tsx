/**
 * Stack of completed-task notifications above the notify / minimap cluster.
 * Click focuses the tasks node, opens the board with the task selected, and
 * durably dismisses this entry.
 *
 * Visual: one “completed” label on the plate plus a mark-all-read button;
 * each card is icon + brief only.
 * Boundless vertical stack — scroll the list; cards are never mid-clipped.
 */
import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import { CheckCheck, CheckCircle2 } from "lucide-react";
import {
  activateCompletedTaskNotify,
  completedTaskNotify$,
  markAllCompletedNotifyRead,
  syncCompletedTaskNotifyFromDoc,
  type CompletedTaskNotifyItem,
} from "../../lib/completed-task-notify";
import { state$ } from "../../lib/state";

export function CompletedTaskNotifyStack() {
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const canvasLoading = use$(state$.canvasLoading);
  const items = use$(completedTaskNotify$.items);

  useEffect(() => {
    // Boot / navigation gap: EMPTY_DOC or in-flight open is not a projection.
    if (!canvasName || canvasLoading) return;
    syncCompletedTaskNotifyFromDoc(doc.nodes);
  }, [doc, canvasName, canvasLoading]);

  if (items.length === 0) return null;

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
        <button
          type="button"
          className="completed-task-notify__mark-all"
          title="Mark all read — clears the stack without opening anything"
          aria-label={`Mark all ${String(items.length)} completed tasks read`}
          data-testid="completed-task-notify-mark-all"
          onClick={markAllCompletedNotifyRead}
        >
          <CheckCheck size={11} aria-hidden />
          mark all read
        </button>
      </div>
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
      aria-label={`Completed: ${item.brief}. Open task board.`}
      onClick={() => activateCompletedTaskNotify(item)}
    >
      <CheckCircle2 size={15} className="completed-task-notify__icon" aria-hidden />
      <span className="completed-task-notify__brief">{item.brief}</span>
    </button>
  );
}
