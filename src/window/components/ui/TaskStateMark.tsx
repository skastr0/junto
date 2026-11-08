import type { CSSProperties } from "react";
import { Archive, Check, CircleCheck, CircleDashed, CirclePause, CircleSlash, Circle, Stamp, X, type LucideIcon } from "lucide-react";
import {
  STAMP_SLOT_VISUAL,
  TASK_STATE_VISUAL,
  markColor,
  stampSummary,
  type StampSlot,
  type StampTally as StampTallyData,
  type TaskStateGlyph,
  type TaskStateV10,
} from "../../lib/resource-visuals";
import { StatusDot } from "./StatusDot";
import "./task-state.css";

const GLYPH: Readonly<Record<Exclude<TaskStateGlyph, "lamp">, LucideIcon>> = {
  "dashed-circle": CircleDashed,
  circle: Circle,
  pause: CirclePause,
  stamp: Stamp,
  check: CircleCheck,
  slash: CircleSlash,
  box: Archive,
};

/**
 * TaskStateMark: where a task is, as one mark and an optional word. Every
 * state has its own shape, so the state reads without its hue: a dashed ring
 * for backlog, a ring for assigned, a pulsing lamp for working (the only
 * live mark), a pause for needs input, a stamp for in review, a check for
 * done, a slash for canceled, a box for archived. The word stays ink; the
 * hue lives on the mark.
 *
 * `pending` puts a dashed halo around the mark when the state is a queued
 * command not yet ruled (02): the task is shown where the writer expects it
 * to land, the lamp stops pulsing, and a screen reader hears "queued". The
 * halo is drawn on the mark's own box, so no glyph is cut up and nothing
 * moves when a state is ruled.
 */
export function TaskStateMark({
  state,
  withLabel = false,
  pending = false,
}: {
  readonly state: TaskStateV10;
  /** Draw the state's word beside the mark. The mark alone is for a dense row, with a title. */
  readonly withLabel?: boolean;
  readonly pending?: boolean;
}) {
  const visual = TASK_STATE_VISUAL[state];
  const spoken = pending ? `${visual.label}, queued` : visual.label;
  const mark =
    visual.glyph === "lamp" ? (
      <StatusDot tone="amber" pulse={!pending} />
    ) : (
      (() => {
        const Glyph = GLYPH[visual.glyph];
        return <Glyph size={13} aria-hidden />;
      })()
    );
  return (
    <span
      className="task-state"
      data-state={state}
      data-pending={pending ? "true" : undefined}
      data-settled={visual.settled ? "true" : undefined}
      style={{ "--mark": markColor(visual.tone) } as CSSProperties}
      {...(withLabel ? {} : { role: "img", "aria-label": spoken, title: spoken })}
    >
      <span className="task-state__mark" aria-hidden>
        {mark}
      </span>
      {withLabel ? <span className="task-state__label">{spoken}</span> : null}
    </span>
  );
}

const SLOT_GLYPH: Readonly<Record<StampSlot, LucideIcon | undefined>> = {
  approved: Check,
  changes: X,
  pending: Check,
  waiting: undefined,
  stale: undefined,
};

/**
 * StampTally: the review stamps of a task as a row of small caps, one per
 * stamp the policy asks for. A ruled approval is a filled green cap with a
 * check, a request for changes a filled crimson cap with a cross (the one
 * crimson on a task: it blocks done), a missing approval an empty cap, a
 * queued approval a dashed cap, a stamp from an earlier round a dashed faint
 * cap that no longer counts. `summary` writes the count beside the caps.
 */
export function StampTally({ tally, summary = true }: { readonly tally: StampTallyData; readonly summary?: boolean }) {
  const text = stampSummary(tally);
  return (
    <span className="stamp-tally" role="img" aria-label={text} title={text}>
      <span className="stamp-tally__caps" aria-hidden>
        {tally.slots.map((slot, index) => {
          const visual = STAMP_SLOT_VISUAL[slot];
          const Glyph = SLOT_GLYPH[slot];
          return (
            <span
              key={index}
              className="stamp-tally__cap"
              data-slot={slot}
              data-dashed={visual.dashed ? "true" : undefined}
              data-filled={visual.filled ? "true" : undefined}
              style={{ "--mark": markColor(visual.tone) } as CSSProperties}
            >
              {Glyph ? <Glyph size={9} strokeWidth={3} /> : null}
            </span>
          );
        })}
      </span>
      {summary ? (
        <span className="stamp-tally__summary" aria-hidden>
          {text}
        </span>
      ) : null}
    </span>
  );
}
