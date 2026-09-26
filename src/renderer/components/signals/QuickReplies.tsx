import { Button } from "../ui";
import "./quick-replies.css";

/**
 * One-click answers for an open signal: the operator's quick replies as a
 * row of quiet pills. Picking one sends it as the reply. With `numbered`,
 * each pill shows the 1..9 key that picks it.
 */
export function QuickReplies({
  replies,
  onPick,
  pending,
  numbered = false,
  className,
}: {
  readonly replies: ReadonlyArray<string>;
  readonly onPick: (text: string) => void;
  /** The reply being sent, if any: every pill waits while one is in flight. */
  readonly pending: string | null;
  readonly numbered?: boolean;
  readonly className?: string;
}) {
  if (replies.length === 0) return null;
  return (
    <div
      className={["quick-replies", className].filter(Boolean).join(" ")}
      role="group"
      aria-label="Quick replies"
      data-testid="quick-replies"
    >
      {replies.map((text, index) => {
        const key = index < 9 ? String(index + 1) : null;
        return (
          <Button
            key={text}
            size="md"
            variant="chrome"
            className="quick-reply"
            disabled={pending !== null}
            aria-busy={pending === text ? true : undefined}
            aria-keyshortcuts={numbered && key ? key : undefined}
            title={`Reply "${text}"${numbered && key ? ` (${key})` : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onPick(text);
            }}
          >
            {numbered && key ? (
              <span className="quick-reply__key" aria-hidden>
                {key}
              </span>
            ) : null}
            {text}
          </Button>
        );
      })}
    </div>
  );
}
