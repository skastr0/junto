import type { ReactNode } from "react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentSignal } from "@shared/agent-signals";
import { SEAT_ONBOARDING_LABEL, type SeatOnboardingStatus } from "@shared/seat-onboarding-status";
import type { ThreadHealthTone, ThreadHealthValue } from "@shared/thread-health";
import type { ActivitySpec, ActivityTone } from "../../lib/activity";
import { bindingIdForNode } from "../../lib/agent-seat-state";
import { useSeatSignalRollup } from "../../lib/agent-signals-state";
import { openOperatorModal } from "../../lib/operator-modal";
import { useSeatOnboarding } from "../../lib/seat-onboarding";
import { seatSaying } from "../../lib/seat-line";
import { state$ } from "../../lib/state";
import { useThreadHealthMark } from "../../lib/thread-health";
import { seatPortraitMood } from "../../lib/portrait-mood";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import { resolveActivityGlyph } from "../../lib/activity";
import { publishSeatUrgency, seatUrgencyOfRing } from "../../lib/region-urgency";
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

/** A seat's name, as every seat prints it: on the canvas and in the agent modal's rail. */
export function SeatName({ name, color }: { readonly name: string; readonly color: string }) {
  return (
    <div className="truncate font-mono text-[13px] font-semibold leading-snug" style={{ color }} title={name}>
      {name}
    </div>
  );
}

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
  onboarding,
  onSignalOpen,
  overseer = false,
  compact = false,
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
  /** Whether the agent ran `junto onboard` in this session; absent until known. */
  readonly onboarding?: SeatOnboardingStatus;
  readonly onSignalOpen?: () => void;
  /** An overseer seat: a crest on the ring, no second border or tab. */
  readonly overseer?: boolean;
  /** The ring and portrait alone, name and line left out (a narrow strip of seats). */
  readonly compact?: boolean;
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
      {compact ? null : (
      <div className="junto-seat__text min-w-0 flex-1">
        {title}
        <div className="junto-seat__line flex items-baseline gap-1.5 text-[10.5px] leading-snug">
          <span className="min-w-0 flex-1 truncate" data-testid="agent-seat-line">
            {line}
          </span>
          {onboarding ? (
            // A quiet fact beside the line, never the line itself: a seat
            // nobody has spoken to yet is not onboarded and nothing is wrong.
            <span
              className={`shrink-0 font-display text-[9px] tracking-[0.12em] uppercase ${onboarding === "onboarded" ? "text-faint" : "text-dim"}`}
              data-testid="agent-seat-onboarding"
              data-onboarding={onboarding}
            >
              {SEAT_ONBOARDING_LABEL[onboarding]}
            </span>
          ) : null}
        </div>
        {children}
      </div>
      )}
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
  const onboarding = useSeatOnboarding(node);
  // What the ring says, for the regions and the minimap (region-urgency.ts).
  const urgency = seatUrgencyOfRing({
    glyph: resolveActivityGlyph(rest.activity.mode, rest.activity.tone, rest.activity.glyph),
    signal: rollup?.kind,
    health: health.health,
    healthStale: health.healthStale,
  });
  useEffect(() => {
    publishSeatUrgency(node.id, urgency);
  }, [node.id, urgency]);
  useEffect(() => () => publishSeatUrgency(node.id, undefined), [node.id]);
  return (
    <AgentSeatView
      identity={node.id}
      health={health}
      signal={{ worst: rollup?.signal, openCount: rollup?.openCount ?? 0 }}
      onboarding={onboarding}
      // A signal is answered in the needs-you feed.
      onSignalOpen={() => openOperatorModal("feed")}
      {...rest}
    />
  );
}
