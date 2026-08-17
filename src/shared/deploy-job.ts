/**
 * Live Remote deploy job projection for fleet UI.
 * Main owns the job; renderer only mirrors.
 */
export type HostDeployJobStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "auth_required";

/** Live stdin of the copy hop (tar/zip). Remote unpack continues after this hits 100. */
export type HostDeployCopyProgress = {
  readonly bytesSent: number;
  readonly bytesTotal: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** True once the local payload has finished — Remote is still unpacking. */
  readonly payloadComplete?: boolean;
};

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
  readonly copy?: HostDeployCopyProgress;
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

const COPY_STAGE = /^Copying Vellum Command/u;
/** Copy sits at milestone 40; live bytes fill 40–54 until the payload is gone. */
export const COPY_PERCENT_FLOOR = 40;
export const COPY_PERCENT_CEILING = 54;

export const isCopyStageLabel = (stage: string | undefined): boolean =>
  stage !== undefined && COPY_STAGE.test(stage);

export const percentFromDeployProgress = (
  stages: readonly string[],
  status: HostDeployJobStatus,
  copy?: HostDeployCopyProgress,
): number => {
  const base = percentFromStages(stages, status);
  if (status !== "running" || copy === undefined) return base;
  if (!isCopyStageLabel(stages[stages.length - 1])) return base;
  if (!(copy.bytesTotal > 0)) return base;
  const frac = Math.min(1, copy.bytesSent / copy.bytesTotal);
  return Math.min(
    COPY_PERCENT_CEILING,
    COPY_PERCENT_FLOOR + Math.floor(frac * (COPY_PERCENT_CEILING - COPY_PERCENT_FLOOR)),
  );
};

export const formatDeployBytes = (bytes: number): string => {
  const n = Math.max(0, bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};

export const copyProgressLabel = (
  copy: HostDeployCopyProgress,
  nowMs: number,
): string => {
  const sent = formatDeployBytes(copy.bytesSent);
  const total = formatDeployBytes(Math.max(copy.bytesTotal, copy.bytesSent));
  if (copy.payloadComplete === true) {
    return `${sent} copied — installing on the Remote`;
  }
  const started = Date.parse(copy.startedAt);
  const elapsedMs = Number.isFinite(started) ? Math.max(0, nowMs - started) : 0;
  if (elapsedMs < 800 || copy.bytesSent <= 0) {
    return `${sent} / ${total}`;
  }
  const bytesPerSec = (copy.bytesSent * 1000) / elapsedMs;
  const rate = `${formatDeployBytes(bytesPerSec)}/s`;
  const remain = Math.max(0, copy.bytesTotal - copy.bytesSent);
  if (remain <= 0 || bytesPerSec < 1) return `${sent} / ${total} — ${rate}`;
  const remainSec = Math.round(remain / bytesPerSec);
  const eta =
    remainSec < 60
      ? `about ${remainSec}s left`
      : `about ${Math.floor(remainSec / 60)}m ${remainSec % 60}s left`;
  return `${sent} / ${total} — ${rate} — ${eta}`;
};
