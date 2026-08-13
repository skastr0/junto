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

/** Copy / sign / restart / wait — recorded while SSH answers. */
export const HOST_RUNTIME_REMEDY_STAGE = {
  copy: "Copying Vellum Command",
  copyAgain: "Copying Vellum Command again",
  sign: "Signing Vellum Command",
  restart: "Restarting Vellum Command",
  wait: "Waiting for Vellum Command to answer",
} as const;

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
  { match: /^Copying Vellum Command/u, percent: 40 },
  { match: /^first-install package .+ installed/u, percent: 55 },
  { match: /^Signing Vellum Command/u, percent: 58 },
  { match: /^starting sealed adopt/u, percent: 60 },
  {
    match: /station configured via enrollment bootstrap/u,
    percent: 70,
  },
  {
    match: /retrying package activation for work-control readiness/u,
    percent: 75,
  },
  { match: /^Restarting Vellum Command/u, percent: 80 },
  { match: /^root-owned transaction .+ committed/u, percent: 85 },
  { match: /^Waiting for Vellum Command to answer/u, percent: 90 },
  { match: /^systemd generation/u, percent: 95 },
];

export const mergeDeployJobStages = (
  ...lists: Array<readonly string[] | undefined>
): readonly string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (list === undefined) continue;
    for (const stage of list) {
      if (seen.has(stage)) continue;
      seen.add(stage);
      merged.push(stage);
    }
  }
  return merged.slice(-48);
};

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
