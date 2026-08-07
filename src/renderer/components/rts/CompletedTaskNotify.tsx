/**
 * Stack of completed-task notifications above the notify / minimap cluster.
 * Click focuses the tasks node, opens the board with the task selected, and
 * dismisses this entry.
 */
import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import { CheckCircle2 } from "lucide-react";
import {
  activateCompletedTaskNotify,
  completedTaskNotify$,
  resetCompletedTaskNotify,
  syncCompletedTaskNotifyFromDoc,
} from "../../lib/completed-task-notify";
import { state$ } from "../../lib/state";

export function CompletedTaskNotifyStack() {
  const doc = use$(state$.doc);
  const items = use$(completedTaskNotify$.items);

  useEffect(() => {
    syncCompletedTaskNotifyFromDoc(doc.nodes);
  }, [doc]);

  useEffect(() => {
    return () => {
      // Full unmount of RTS chrome — re-baseline next mount.
      resetCompletedTaskNotify();
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="completed-task-notify"
      role="region"
      aria-label="Completed tasks"
      data-testid="completed-task-notify"
    >
      {items.map((item) => (
        <button
          key={item.id}
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
      ))}
    </div>
  );
}
