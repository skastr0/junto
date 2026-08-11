/**
 * Completed-task notifications: a **deck** of cards stacked on top of each
 * other (not a vertical list). Newest sits on top; cards underneath peek with
 * a slight offset. Wheel / trackpad cycles which card is face-up. Click the
 * face card to open + dismiss.
 *
 * No plate chrome, no "completed" copy — icon + brief only.
 */
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type WheelEvent,
} from "react";
import { use$ } from "@legendapp/state/react";
import { CheckCircle2 } from "lucide-react";
import {
  activateCompletedTaskNotify,
  completedTaskNotify$,
  syncCompletedTaskNotifyFromDoc,
  type CompletedTaskNotifyItem,
} from "../../lib/completed-task-notify";
import { state$ } from "../../lib/state";

/** How many under-cards peek below the face card. */
const PEEK_COUNT = 4;

export function CompletedTaskNotifyStack() {
  const doc = use$(state$.doc);
  const items = use$(completedTaskNotify$.items);
  const [faceIndex, setFaceIndex] = useState(0);

  useEffect(() => {
    syncCompletedTaskNotifyFromDoc(doc.nodes);
  }, [doc]);

  // Clamp face when the stack shrinks (dismiss).
  useEffect(() => {
    if (items.length === 0) {
      setFaceIndex(0);
      return;
    }
    setFaceIndex((i) => Math.min(i, items.length - 1));
  }, [items.length]);

  const deck = useMemo(() => {
    if (items.length === 0) return [];
    // Face card first, then the rest in order — true deck order for stacking.
    const rotated = [
      ...items.slice(faceIndex),
      ...items.slice(0, faceIndex),
    ];
    // Only face + peek layers need DOM (deeper cards sit under the same silhouette).
    return rotated.slice(0, PEEK_COUNT + 1);
  }, [items, faceIndex]);

  if (items.length === 0) return null;

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (items.length <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    const dir = event.deltaY > 0 || event.deltaX > 0 ? 1 : -1;
    setFaceIndex((i) => (i + dir + items.length) % items.length);
  };

  return (
    <div
      className="completed-task-notify"
      role="region"
      aria-label="Finished tasks"
      aria-roledescription="card stack"
      data-testid="completed-task-notify"
      data-stack-count={items.length}
      onWheel={onWheel}
    >
      <div
        className="completed-task-notify__deck"
        style={
          {
            // Reserve room for face card + peeks so nothing is clipped.
            "--stack-peeks": String(Math.min(PEEK_COUNT, Math.max(0, items.length - 1))),
          } as CSSProperties
        }
      >
        {deck.map((item, stackI) => (
          <CompletedTaskNotifyCard
            key={item.id}
            item={item}
            stackIndex={stackI}
            isFace={stackI === 0}
            depthLabel={
              stackI === 0
                ? `${faceIndex + 1} of ${items.length}`
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

function CompletedTaskNotifyCard({
  item,
  stackIndex,
  isFace,
  depthLabel,
}: {
  readonly item: CompletedTaskNotifyItem;
  readonly stackIndex: number;
  readonly isFace: boolean;
  readonly depthLabel?: string;
}) {
  return (
    <button
      type="button"
      className="completed-task-notify__item"
      data-stack-index={stackIndex}
      data-face={isFace ? "true" : "false"}
      style={{ "--stack-i": String(stackIndex) } as CSSProperties}
      tabIndex={isFace ? 0 : -1}
      aria-hidden={isFace ? undefined : true}
      title={isFace ? `${item.brief} — open task` : undefined}
      aria-label={
        isFace
          ? `Open finished task: ${item.brief}${depthLabel ? ` (${depthLabel})` : ""}`
          : undefined
      }
      onClick={() => {
        if (!isFace) return;
        activateCompletedTaskNotify(item);
      }}
    >
      <CheckCircle2 size={15} className="completed-task-notify__icon" aria-hidden />
      <span className="completed-task-notify__brief">{item.brief}</span>
      {isFace && depthLabel ? (
        <span className="completed-task-notify__depth" aria-hidden>
          {depthLabel}
        </span>
      ) : null}
    </button>
  );
}
