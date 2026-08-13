/**
 * In-memory Remote deploy job registry (main process).
 * Jobs outlive fleet panel unmounts; renderer mirrors via IPC events.
 */
import { randomBytes } from "node:crypto";
import {
  mergeDeployJobStages,
  percentFromStages,
  type HostDeployJobSnapshot,
  type HostDeployJobStatus,
} from "../../../shared/deploy-job";

const jobsByHost = new Map<string, HostDeployJobSnapshot>();
const listeners = new Set<(job: HostDeployJobSnapshot) => void>();

const nowIso = (): string => new Date().toISOString();

const publish = (job: HostDeployJobSnapshot): void => {
  jobsByHost.set(job.hostId, job);
  for (const listener of listeners) {
    try {
      listener(job);
    } catch {
      // Renderer listeners must not break deploy.
    }
  }
};

export const subscribeDeployJobs = (
  listener: (job: HostDeployJobSnapshot) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getDeployJob = (
  hostId: string,
): HostDeployJobSnapshot | undefined => jobsByHost.get(hostId);

export const listDeployJobs = (): ReadonlyArray<HostDeployJobSnapshot> =>
  [...jobsByHost.values()].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );

export const beginDeployJob = (hostId: string): HostDeployJobSnapshot => {
  const startedAt = nowIso();
  const job: HostDeployJobSnapshot = {
    jobId: randomBytes(8).toString("hex"),
    hostId,
    status: "running",
    stages: ["deploy accepted — running in Command Center main process"],
    percent: 1,
    detail: "Deploy started…",
    startedAt,
    updatedAt: startedAt,
  };
  publish(job);
  return job;
};

export const appendDeployJobStage = (
  hostId: string,
  stage: string,
): void => {
  const current = jobsByHost.get(hostId);
  if (current === undefined || current.status !== "running") return;
  if (current.stages.includes(stage)) return;
  const stages = [...current.stages, stage].slice(-48);
  publish({
    ...current,
    stages,
    percent: percentFromStages(stages, "running"),
    detail: stage,
    updatedAt: nowIso(),
  });
};

export const finishDeployJob = (
  hostId: string,
  input: {
    readonly status: Exclude<HostDeployJobStatus, "running">;
    readonly detail: string;
    readonly stages?: readonly string[];
    readonly version?: string;
    readonly recoveryHint?: string;
  },
): void => {
  const current = jobsByHost.get(hostId);
  const startedAt = current?.startedAt ?? nowIso();
  const stages = mergeDeployJobStages(current?.stages, input.stages);
  const finishedAt = nowIso();
  publish({
    jobId: current?.jobId ?? randomBytes(8).toString("hex"),
    hostId,
    status: input.status,
    stages,
    percent: percentFromStages(stages, input.status),
    detail: input.detail,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.recoveryHint === undefined
      ? {}
      : { recoveryHint: input.recoveryHint }),
    startedAt,
    updatedAt: finishedAt,
    finishedAt,
  });
};

/** Host id for the deploy currently appending stages (main-thread only). */
let activeStageHostId: string | undefined;

export const setActiveDeployJobHost = (hostId: string | undefined): void => {
  activeStageHostId = hostId;
};

export const reportDeployStage = (stage: string): void => {
  if (activeStageHostId === undefined) return;
  appendDeployJobStage(activeStageHostId, stage);
};

/**
 * Bind stage reporting to `hostId` for the duration of `body`.
 * Single-flight: one active deploy host at a time on this process.
 */
export const withDeployJobStageHost = async <T>(
  hostId: string,
  body: () => Promise<T>,
): Promise<T> => {
  setActiveDeployJobHost(hostId);
  try {
    return await body();
  } finally {
    setActiveDeployJobHost(undefined);
  }
};
