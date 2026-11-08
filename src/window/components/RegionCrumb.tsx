import { Fragment } from "react";
import { trailPath, type RegionStep } from "../lib/region-path";
import { accentColor } from "../lib/theme";
import "./region-crumb.css";

/**
 * A node's region path ("Junto / PTY / mail") as a quiet crumb: dim mono, one
 * line, each region's name tinted with that region's own colour so the
 * canvas's colour coding reads here too. A long path clips from the left, so
 * the innermost region survives. The one crumb for every surface that says
 * where a node sits (cmd+K rows, the agent modal's header, the connect
 * list); the trail comes from lib/region-path.
 */
export function RegionCrumb({
  trail,
  className,
  testId,
}: {
  readonly trail: ReadonlyArray<RegionStep>;
  /** Layout only: how the crumb sits among its neighbours. */
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <span
      className={className ? `region-crumb ${className}` : "region-crumb"}
      data-testid={testId}
      title={trailPath(trail)}
    >
      <bdi>
        {trail.map((step, index) => (
          <Fragment key={step.id}>
            {index > 0 ? " / " : null}
            <span
              className="region-crumb__step"
              style={step.color ? { "--crumb-hue": accentColor(step.color) } as React.CSSProperties : undefined}
            >
              {step.name}
            </span>
          </Fragment>
        ))}
      </bdi>
    </span>
  );
}
