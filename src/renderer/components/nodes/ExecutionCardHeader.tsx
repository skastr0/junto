import type { ReactNode } from "react";
import type { ActivitySpec } from "../../lib/activity";
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
          <div className="truncate text-[11px] text-dim">{subtitle}</div>
        ) : null}
      </div>
      <ActivityMarkFromSpec spec={activity} />
    </div>
  );
}
