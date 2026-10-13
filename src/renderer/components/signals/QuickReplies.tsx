import { Sparkle } from "lucide-react";
import { mergedQuickReplies } from "../../lib/quick-replies";
import { Button } from "../ui";
import "./quick-replies.css";

/**
 * One-click answers for an open signal: the seat's suggested replies first,
 * then the operator's quick replies, as a row of quiet pills. Picking one
 * sends it as the reply through the ordinary answer path. With `numbered`,
 * each pill shows the 1..9 key that picks it.
 */
export function QuickReplies({
  replies,
  suggested,
  onPick,
  pending,
  numbered = false,
  to,
  className,
}: {
  readonly replies: ReadonlyArray<string>;
  /** Replies the seat pre-baked for this signal (`--suggest`); they lead. */
  readonly suggested?: ReadonlyArray<string>;
  readonly onPick: (text: string) => void;
  /** The reply being sent, if any: every pill waits while one is in flight. */
  readonly pending: string | null;
  readonly numbered?: boolean;
  /**
   * Whose signal these answer, where several rows of the same replies share
   * a surface: each pill's name then says it ("Reply Yes to Atlas").
   */
  readonly to?: string;
  readonly className?: string;
}) {
  const suggestedSet = new Set(suggested ?? []);
  const entries = mergedQuickReplies(replies, suggested).map((text) => ({
    text,
    suggested: suggestedSet.has(text),
  }));
  if (entries.length === 0) return null;
  return (
    <div
      className={["quick-replies", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={to ? `Quick replies to ${to}` : "Quick replies"}
      data-testid="quick-replies"
    >
      {entries.map((entry, index) => {
        const key = index < 9 ? String(index + 1) : null;
        return (
          <Button
            key={entry.suggested ? `suggested:${entry.text}` : entry.text}
            size="md"
            variant="chrome"
            className={entry.suggested ? "quick-reply quick-reply--suggested" : "quick-reply"}
            disabled={pending !== null}
            aria-busy={pending === entry.text ? true : undefined}
            aria-label={to ? `Reply ${entry.text} to ${to}` : undefined}
            aria-keyshortcuts={numbered && key ? key : undefined}
            title={`Reply "${entry.text}"${entry.suggested ? ", suggested by the seat" : ""}${numbered && key ? ` (${key})` : ""}`}
            onClick={() => onPick(entry.text)}
          >
            {numbered && key ? (
              <span className="quick-reply__key" aria-hidden>
                {key}
              </span>
            ) : null}
            {entry.suggested ? <Sparkle size={10} aria-hidden /> : null}
            {entry.text}
          </Button>
        );
      })}
    </div>
  );
}
