import type { ReactNode } from "react";
import { Eyebrow } from "../ui";

const COUNT_TONE = {
  faint: "text-faint",
  amber: "text-amber",
  crimson: "text-crimson",
} as const;

/** One headed group inside seat details: a quiet title, a count, then its rows. */
export function DetailsGroup({
  title,
  count,
  countTone = "faint",
  meta,
  testId,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  /** Amber when the count is waiting on the operator. */
  readonly countTone?: keyof typeof COUNT_TONE;
  /** Short trailing text after the count, such as "2 unread". */
  readonly meta?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="seat-details__group" aria-label={title} data-testid={testId}>
      <header className="flex items-baseline gap-2">
        <Eyebrow tone="steel" size="xs">
          {title}
        </Eyebrow>
        {count !== undefined && count > 0 ? (
          <span className={`text-label tabular-nums ${COUNT_TONE[countTone]}`}>{count}</span>
        ) : null}
        {meta ? <span className="ml-auto text-label text-faint">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}
