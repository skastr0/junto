/**
 * In-memory Remote deploy job registry (main process).
 * Jobs outlive fleet panel unmounts; renderer mirrors via IPC events.
 * All attribution is per-host: stages, copy progress, and the single-flight
 * deploy slot are keyed by host id, so concurrent deploys to different hosts
 * never cross-attribute.
 */
import { randomBytes } from "node:crypto";
import {
  mergeDeployJobStages,
  percentFromDeployProgress,
  type HostDeployCopyProgress,
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

/**
 * Per-host single-flight admission for the live deploy path. Concurrent
 * deploys for the same host refuse busy (typed by the caller); different
 * hosts proceed independently. Module-level so every coordinator instance
 * (renderer IPC and operator control) shares the same admission.
 */
const activeDeployHosts = new Map<string, symbol>();

export type DeployHostSlot =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false };

export const acquireDeployHostSlot = (hostId: string): DeployHostSlot => {
  if (activeDeployHosts.has(hostId)) return { acquired: false };
  const token = Symbol(hostId);
  activeDeployHosts.set(hostId, token);
  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      if (activeDeployHosts.get(hostId) === token) {
        activeDeployHosts.delete(hostId);
      }
    },
  };
};

type CopyThrottle = { lastPublishAt: number; lastSent: number };
const copyThrottles = new Map<string, CopyThrottle>();
const COPY_PUBLISH_MS = 250;
const COPY_PUBLISH_BYTES = 256 * 1024;

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
  copyThrottles.delete(hostId);
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
    percent: percentFromDeployProgress(stages, "running", current.copy),
    detail: stage,
    updatedAt: nowIso(),
    ...(current.copy === undefined ? {} : { copy: current.copy }),
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
  copyThrottles.delete(hostId);
  publish({
    jobId: current?.jobId ?? randomBytes(8).toString("hex"),
    hostId,
    status: input.status,
    stages,
    percent: percentFromDeployProgress(stages, input.status),
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

export const reportDeployCopyProgress = (
  hostId: string,
  copy: HostDeployCopyProgress,
): void => {
  const current = jobsByHost.get(hostId);
  if (current === undefined || current.status !== "running") return;
  const throttle = copyThrottles.get(hostId) ?? {
    lastPublishAt: 0,
    lastSent: -1,
  };
  const now = Date.now();
  const sentDelta = copy.bytesSent - throttle.lastSent;
  const force =
    throttle.lastSent < 0 ||
    copy.payloadComplete === true ||
    sentDelta >= COPY_PUBLISH_BYTES ||
    now - throttle.lastPublishAt >= COPY_PUBLISH_MS;
  if (!force) return;
  copyThrottles.set(hostId, { lastPublishAt: now, lastSent: copy.bytesSent });
  publish({
    ...current,
    copy,
    percent: percentFromDeployProgress(current.stages, "running", copy),
    updatedAt: copy.updatedAt,
  });
};
