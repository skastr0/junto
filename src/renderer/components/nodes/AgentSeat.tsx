import type { ReactNode } from "react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentSignal } from "@shared/agent-signals";
import type { ThreadHealthTone, ThreadHealthValue } from "@shared/thread-health";
import type { ActivitySpec, ActivityTone } from "../../lib/activity";
import { bindingIdForNode } from "../../lib/agent-seat-state";
import { useSeatSignalRollup } from "../../lib/agent-signals-state";
import { openSeatSignals } from "../../lib/agent-signals-view";
import { seatSaying } from "../../lib/seat-line";
import { state$ } from "../../lib/state";
import { useThreadHealthMark } from "../../lib/thread-health";
import { seatPortraitMood } from "../../lib/portrait-mood";
import { use$ } from "@legendapp/state/react";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { AgentPortrait } from "../AgentPortrait";

/** Portrait inside the 52px seat ring: fits the ring's hole with a hairline gap. */
export const SEAT_PORTRAIT_PX = 34;

const TONE_TEXT: Readonly<Record<ActivityTone, string>> = {
  amber: "text-amber",
  cyan: "text-cyan",
  green: "text-green",
  crimson: "text-crimson",
  steel: "text-steel",
};

export type SeatHealth = {
  readonly health?: ThreadHealthTone;
  readonly value?: ThreadHealthValue;
  readonly healthStale?: boolean;
  readonly label?: string;
  readonly line?: string;
};

export type SeatSignal = {
  readonly worst?: AgentSignal;
  readonly openCount: number;
};

/**
 * An agent seat on the canvas: the portrait held by its living ring, the
 * name, and one line beneath it. The ring is the seat's only status
 * instrument (control state, thread health, declared signal); the line says
 * the loudest of them in words: the seat's own signal first, then a spawn
 * failure, then proven attention (needs input, blocked), then the AI's
 * reading (marked as such; it outranks "done", which may really be
 * waiting), then the control state. The order is seatRollup's.
 * Pure: `AgentSeat` feeds it from the live stores, the gallery from fixtures.
 */
export function AgentSeatView({
  identity,
  activity,
  title,
  harness,
  context,
  health,
  signal,
  onSignalOpen,
  overseer = false,
  children,
}: {
  /** Seat identity (node id) for the portrait. */
  readonly identity: string;
  readonly activity: ActivitySpec;
  /** The name, or its rename input. */
  readonly title: ReactNode;
  /** Managed harness id for the portrait badge. */
  readonly harness?: string;
  /** Spawn failure copy; outranks the health and state line. */
  readonly context?: string;
  readonly health: SeatHealth;
  readonly signal: SeatSignal;
  readonly onSignalOpen?: () => void;
  /** An overseer seat: a crest on the ring, no second border or tab. */
  readonly overseer?: boolean;
  /** Extra rows under the line (claimed task). */
  readonly children?: ReactNode;
}) {
  const open = signal.worst;
  // One order for every seat surface (seatSaying reads seat-rollup.ts): the
  // minimap, the cmd+K row, and this line can never disagree.
  const saying = seatSaying({ activity, signal: open, failure: context, health });
  let line: ReactNode;
  if (saying.kind === "signal") {
    line = (
      <>
        <span className={`${TONE_TEXT[saying.tone]} font-semibold`}>{saying.word}</span>{" "}
        <span className="text-dim" title={saying.text}>
          {saying.text}
        </span>
      </>
    );
  } else if (saying.kind === "failure") {
    line = <span className="text-amber">{saying.text}</span>;
  } else if (saying.kind === "reading") {
    // An AI reading, never the agent's own claim: a quiet prefix, dim ink.
    line = (
      <>
        <span className="mr-1 align-[1px] font-display text-[9px] tracking-[0.12em] text-faint">AI</span>
        <span className={saying.stale ? "text-faint" : "text-dim"}>{saying.text}</span>
      </>
    );
  } else {
    line = <span className={saying.tone ? TONE_TEXT[saying.tone] : "text-dim"}>{saying.text}</span>;
  }

  return (
    <div className="junto-seat flex h-full w-full items-center gap-2" data-testid="agent-seat">
      <ActivityMarkFromSpec
        spec={activity}
        size="seat"
        health={health.health}
        healthValue={health.value}
        healthStale={health.healthStale}
        healthLabel={health.label}
        signal={open?.kind}
        signalCount={signal.openCount}
        onSignalOpen={open ? onSignalOpen : undefined}
        crest={overseer}
      >
        <AgentPortrait
          identity={identity}
          size={SEAT_PORTRAIT_PX}
          frame="round"
          outline={false}
          harness={harness}
          mood={seatPortraitMood(activity, health, open?.kind)}
        />
      </ActivityMarkFromSpec>
      <div className="junto-seat__text min-w-0 flex-1">
        {title}
        <div className="junto-seat__line truncate text-[10.5px] leading-snug" data-testid="agent-seat-line">
          {line}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The live seat: signals and the thread-health reading from their stores. */
export function AgentSeat({
  node,
  ...rest
}: {
  readonly node: CanvasNode;
  readonly activity: ActivitySpec;
  readonly title: ReactNode;
  readonly harness?: string;
  readonly context?: string;
  readonly overseer?: boolean;
  readonly children?: ReactNode;
}) {
  const canvasName = use$(state$.canvasName);
  const rollup = useSeatSignalRollup(canvasName, node.id);
  const health = useThreadHealthMark(bindingIdForNode(node), rollup?.kind);
  return (
    <AgentSeatView
      identity={node.id}
      health={health}
      signal={{ worst: rollup?.signal, openCount: rollup?.openCount ?? 0 }}
      onSignalOpen={() => openSeatSignals(node)}
      {...rest}
    />
  );
}
