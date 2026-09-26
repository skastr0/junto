import type { ReactNode } from "react";
import type { ActivitySpec } from "../../lib/activity";
import { ActivityMarkFromSpec } from "../ActivityMark";

/** The ring an instrument sits in: a step below the agent's 52px seat. */
export const INSTRUMENT_RING_PX = 40;

/**
 * A canvas instrument (terminal, git) in the agent seat's language: its
 * glyph held by the same living ring a portrait sits in, the name, and one
 * line beneath. The ring is the status instrument; the line says what the
 * instrument is doing in words. No card chrome of its own: the shell's seat
 * rules (factory-grammar.css) give it a surface only on hover and selection.
 */
export function InstrumentSeat({
  activity,
  glyph,
  title,
  line,
  lineTitle,
  children,
}: {
  readonly activity: ActivitySpec;
  /** The kind's glyph, drawn in the ring's hole. */
  readonly glyph: ReactNode;
  /** The name, or its rename input. */
  readonly title: ReactNode;
  readonly line: ReactNode;
  /** Full text of the line when it truncates. */
  readonly lineTitle?: string;
  /** Extra rows under the line (claimed task). */
  readonly children?: ReactNode;
}) {
  return (
    <div className="junto-seat flex h-full w-full items-center gap-2" data-testid="instrument-seat">
      <ActivityMarkFromSpec spec={activity} size="glance" unit={INSTRUMENT_RING_PX}>
        <span className="junto-instrument__glyph" aria-hidden>
          {glyph}
        </span>
      </ActivityMarkFromSpec>
      <div className="junto-seat__text min-w-0 flex-1">
        {title}
        <div className="junto-seat__line truncate text-[10.5px] leading-snug text-dim" data-testid="instrument-seat-line" title={lineTitle}>
          {line}
        </div>
        {children}
      </div>
    </div>
  );
}
