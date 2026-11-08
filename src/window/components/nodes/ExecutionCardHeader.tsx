import type { ReactNode } from "react";
import type { ActivitySpec } from "../../lib/activity";
import { ActivityMarkFromSpec, type MarkOverlayProps } from "../ActivityMark";

/** Health and signal inputs the card forwards to its one mark. */
export type CardMarkOverlay = Omit<MarkOverlayProps, "children">;

/**
 * Shared identity row for executable/terminal cards.
 *
 * Decals and copy remain kind-specific. Geometry and live-state placement do
 * not: every card exposes exactly one ActivityMark in the upper-right slot,
 * carrying control state, the thread-health reading and the declared signal.
 */
export function ExecutionCardHeader({
  decal,
  title,
  subtitle,
  activity,
  overlay,
}: {
  readonly decal: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly activity: ActivitySpec;
  readonly overlay?: CardMarkOverlay;
}) {
  // A settled card with nothing to say stays silent so a fleet of idle seats
  // doesn't light every corner. A health reading or a signal always shows.
  const speaks =
    activity.mode !== "static" ||
    activity.glyph === "done" ||
    (overlay?.health !== undefined && overlay.health !== "steady") ||
    overlay?.signal !== undefined;
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
      {speaks ? (
        <ActivityMarkFromSpec spec={activity} {...overlay} />
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
