import { spawnSync } from "node:child_process";

/** POSIX identity captured only for a detached group Vellum just spawned. */
export type ProcessGroupEpoch = {
  readonly startKey: string;
  readonly processGroupId: number;
  readonly sessionId: number;
};

export type ProcessEpochReader = {
  readonly startKey: (pid: number) => string | undefined;
  readonly processGroupId: (pid: number) => number | undefined;
  readonly sessionId: (pid: number) => number | undefined;
  readonly groupMembers: (processGroupId: number) => readonly { readonly pid: number; readonly processGroupId: number; readonly sessionId: number }[];
};

const systemReader: ProcessEpochReader = {
  startKey: (pid) => {
    try {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 500 });
      const value = (result.stdout ?? "").trim();
      return result.status === 0 && value ? value : undefined;
    } catch { return undefined; }
  },
  processGroupId: (pid) => {
    try {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 500 });
      const value = (result.stdout ?? "").trim();
      return result.status === 0 && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : undefined;
    } catch { return undefined; }
  },
  sessionId: (pid) => {
    try {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "sess="], { encoding: "utf8", timeout: 500 });
      const value = (result.stdout ?? "").trim();
      return result.status === 0 && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : undefined;
    } catch { return undefined; }
  },
  groupMembers: (processGroupId) => {
    try {
      const result = spawnSync("ps", ["-g", String(processGroupId), "-o", "pid=,pgid=,sess="], { encoding: "utf8", timeout: 500 });
      if (result.status !== 0) return [];
      return (result.stdout ?? "").split("\n").flatMap((line) => {
        const match = line.trim().match(/^([1-9][0-9]*)\s+([1-9][0-9]*)\s+(0|[1-9][0-9]*)$/);
        return match ? [{ pid: Number(match[1]), processGroupId: Number(match[2]), sessionId: Number(match[3]) }] : [];
      });
    } catch { return []; }
  },
};

let reader: ProcessEpochReader = systemReader;

export const captureProcessGroupEpoch = (pid: number): ProcessGroupEpoch | undefined => {
  const startKey = reader.startKey(pid);
  const processGroupId = reader.processGroupId(pid);
  const sessionId = reader.sessionId(pid);
  return startKey !== undefined && processGroupId === pid && sessionId !== undefined
    ? { startKey, processGroupId, sessionId }
    : undefined;
};

export const processGroupEpochIsCurrent = (pid: number, epoch: ProcessGroupEpoch): boolean =>
  (reader.startKey(pid) === epoch.startKey && reader.processGroupId(pid) === pid && reader.sessionId(pid) === epoch.sessionId)
  || (() => {
    // The original leader may have exited while descendants remain. A group
    // signal stays safe only when members still prove the captured session and
    // no replacement group leader occupies the original pid.
    const members = reader.groupMembers(pid);
    return members.some((member) => member.processGroupId === pid && member.sessionId === epoch.sessionId)
      && !members.some((member) => member.pid === pid && member.processGroupId === pid);
  })();

/** Test-only observation seam; it cannot mint or signal process authority. */
export const setProcessEpochReaderForTests = (next: ProcessEpochReader | undefined): void => {
  reader = next ?? systemReader;
};
