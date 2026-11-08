import { BellOff, Sparkle } from "lucide-react";
import { answerLabel, mergedQuickReplies } from "../../lib/quick-reply-rules";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";
import "./quick-replies.css";

/**
 * One-click answers for an open signal: the seat's suggested replies first,
 * then the operator's quick replies, as a row of quiet pills. Picking one
 * sends it as the reply through the ordinary answer path. With `numbered`,
 * each pill leads with the 1..9 key that picks it, as a key cap.
 *
 * With `quiet`, the row is the operator's quiet notes instead: each pill
 * answers without mail, so the seat is not woken, and is drawn apart from
 * the waking row (a muted bell, a dashed edge) with Shift+1..9 as its keys.
 */
export function QuickReplies({
  replies,
  suggested,
  onPick,
  pending,
  numbered = false,
  quiet = false,
  to,
  wakes = true,
  className,
}: {
  readonly replies: ReadonlyArray<string>;
  /** Replies the seat pre-baked for this signal (`--suggest`); they lead. */
  readonly suggested?: ReadonlyArray<string>;
  readonly onPick: (text: string) => void;
  /** The reply being sent, if any: every pill waits while one is in flight. */
  readonly pending: string | null;
  readonly numbered?: boolean;
  /** Quiet notes: answered, the seat is not woken. `suggested` is ignored. */
  readonly quiet?: boolean;
  /**
   * Whose signal these answer, where several rows of the same replies share
   * a surface: each pill's name then says it ("Reply Yes to Atlas").
   */
  readonly to?: string;
  /**
   * Whether the answer mails and wakes a seat. An automation's signal has no
   * seat to wake: its answer is recorded and the automation gets it.
   */
  readonly wakes?: boolean;
  readonly className?: string;
}) {
  const suggestedSet = new Set(quiet ? [] : (suggested ?? []));
  const entries = (quiet ? replies : mergedQuickReplies(replies, suggested)).map((text) => ({
    text,
    suggested: suggestedSet.has(text),
  }));
  if (entries.length === 0) return null;
  const rowName = quiet ? "Quiet notes" : "Quick replies";
  return (
    <div
      className={["quick-replies", quiet ? "quick-replies--quiet" : null, className].filter(Boolean).join(" ")}
      role="group"
      aria-label={to ? `${rowName} to ${to}` : rowName}
      data-testid={quiet ? "quiet-notes" : "quick-replies"}
    >
      {entries.map((entry, index) => {
        const digit = index < 9 ? String(index + 1) : null;
        const key = numbered && digit ? (quiet ? `⇧${digit}` : digit) : null;
        const busy = pending === answerLabel(quiet ? { kind: "quiet", text: entry.text } : { kind: "reply", text: entry.text });
        const does = quiet
          ? `Send "${entry.text}" quietly: answered, the seat is not woken`
          : wakes
            ? `Reply "${entry.text}"${entry.suggested ? ", suggested by the seat" : ""}: mails and wakes the seat`
            : `Reply "${entry.text}"${to === undefined ? "" : ` to ${to}`}: the automation gets it as your answer`;
        return (
          <Button
            key={entry.suggested ? `suggested:${entry.text}` : entry.text}
            size="md"
            variant="chrome"
            className={["quick-reply", entry.suggested ? "quick-reply--suggested" : null, quiet ? "quick-reply--quiet" : null]
              .filter(Boolean)
              .join(" ")}
            disabled={pending !== null}
            aria-busy={busy ? true : undefined}
            aria-label={to ? (quiet ? `Note ${entry.text} to ${to}, quietly` : `Reply ${entry.text} to ${to}`) : undefined}
            aria-keyshortcuts={key && digit ? (quiet ? `Shift+${digit}` : digit) : undefined}
            title={`${does}${key ? ` (${key})` : ""}`}
            onClick={() => onPick(entry.text)}
          >
            {key ? (
              <Kbd className="quick-reply__key" aria-hidden>
                {key}
              </Kbd>
            ) : null}
            {entry.suggested ? <Sparkle size={10} aria-hidden /> : null}
            {quiet ? <BellOff size={11} aria-hidden /> : null}
            {entry.text}
          </Button>
        );
      })}
    </div>
  );
}
