import type { ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import type { ActivitySpec } from "../../lib/activity";
import { surfaceMotionLive$ } from "../../lib/surface-motion";
import { ActivityMarkFromSpec } from "../ActivityMark";

/**
 * Shared identity row for executable/terminal cards.
 *
 * Decals and copy remain kind-specific. Geometry and live-state placement do
 * not: every card exposes exactly one ActivityMark in the upper-right slot.
 */
export function ExecutionCardHeader({
  decal,
  title,
  subtitle,
  activity,
}: {
  readonly decal: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly activity: ActivitySpec;
}) {
  const surfaceLive = use$(surfaceMotionLive$);
  // wave (work/block/attention) and pulse (ready/complete) both paint; static
  // stays silent so a fleet of idle seats doesn't light every corner.
  const animated =
    (activity.mode === "wave" || activity.mode === "pulse") && surfaceLive;
  return (
    <div className="flex items-center gap-2">
      {decal}
      <div className="min-w-0 flex-1">
        {typeof title === "string" ? (
          <div className="truncate font-mono text-[14px] font-semibold leading-snug text-ink">
            {title}
          </div>
        ) : (
          title
        )}
        {subtitle ? (
          <div className="min-w-0 text-[11px] leading-snug text-dim">{subtitle}</div>
        ) : null}
      </div>
      {animated ? (
        <ActivityMarkFromSpec spec={activity} />
      ) : (
        <span
          role="status"
          aria-label={activity.label}
          title={activity.label}
          className="sr-only"
        />
      )}
    </div>
  );
}
