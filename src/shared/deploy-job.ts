/**
 * Live Remote deploy job projection for fleet UI.
 * Main owns the job; renderer only mirrors.
 */
export type HostDeployJobStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "auth_required";

export interface HostDeployJobSnapshot {
  readonly jobId: string;
  readonly hostId: string;
  readonly status: HostDeployJobStatus;
  readonly stages: readonly string[];
  /** 0–100; derived from known stage milestones when possible. */
  readonly percent: number;
  readonly detail: string;
  readonly version?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly recoveryHint?: string;
}

/** Rough milestone weights for progress bar (labels match appendStage prefixes). */
export const DEPLOY_STAGE_MILESTONES: ReadonlyArray<{
  readonly match: RegExp;
  readonly percent: number;
}> = [
  { match: /^endpoint ok/u, percent: 5 },
  { match: /^ssh warm/u, percent: 10 },
  { match: /^remote uname/u, percent: 12 },
  { match: /^signed artifact admitted/u, percent: 20 },
  { match: /^preflight ok/u, percent: 30 },
  { match: /^terminal route cut held/u, percent: 35 },
  { match: /^first-install package .+ installed/u, percent: 55 },
  { match: /^starting sealed adopt/u, percent: 60 },
  {
    match: /station configured via enrollment bootstrap/u,
    percent: 70,
  },
  {
    match: /retrying package activation for work-control readiness/u,
    percent: 75,
  },
  { match: /^root-owned transaction .+ committed/u, percent: 85 },
  { match: /^systemd generation/u, percent: 95 },
];

export const percentFromStages = (
  stages: readonly string[],
  status: HostDeployJobStatus,
): number => {
  if (status === "succeeded") return 100;
  let best = 2;
  for (const stage of stages) {
    for (const milestone of DEPLOY_STAGE_MILESTONES) {
      if (milestone.match.test(stage)) {
        best = Math.max(best, milestone.percent);
      }
    }
  }
  if (status === "running") return Math.min(best, 97);
  return best;
};
