import { threadWhen, useThreadToday } from "../../lib/thread-time";

/**
 * When a thread or a message was written: the one way every thread list and
 * every message says it (`lib/thread-time`). What is drawn is short; the
 * hover and a screen reader get the whole date and time.
 */
export function ThreadTime({
  at,
  form = "row",
  className,
}: {
  readonly at: number;
  /** `row` in a list; `message` on a message and wherever the hour matters beside the day. */
  readonly form?: "row" | "message";
  readonly className?: string;
}) {
  const when = threadWhen(at, useThreadToday());
  return (
    <time className={className} dateTime={when.iso} title={when.whole} data-testid="thread-time">
      <span aria-hidden="true">{when[form]}</span>
      <span className="sr-only">{when.whole}</span>
    </time>
  );
}
