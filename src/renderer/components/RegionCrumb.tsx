import "./region-crumb.css";

/**
 * A node's region path ("Junto / PTY / mail") as a quiet crumb: dim mono, one
 * line. A long path clips from the left, so the innermost region survives.
 * The one crumb for every surface that says where a node sits (cmd+K rows,
 * the agent modal's header); the path comes from lib/region-path.
 */
export function RegionCrumb({
  path,
  className,
  testId,
}: {
  readonly path: string;
  /** Layout only: how the crumb sits among its neighbours. */
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <span className={className ? `region-crumb ${className}` : "region-crumb"} data-testid={testId} title={path}>
      <bdi>{path}</bdi>
    </span>
  );
}
