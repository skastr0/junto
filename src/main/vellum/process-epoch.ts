import { spawnSync } from "node:child_process";

/** One row from one `ps` observation; never compose identity from multiple reads. */
export type ProcessEpochRow = {
  readonly pid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startKey: string;
};

export type ChildProcessEpoch = Pick<ProcessEpochRow, "pid" | "startKey">;
export type ProcessGroupEpoch = Pick<ProcessEpochRow, "processGroupId" | "sessionId" | "startKey">;
export type ProcessEpochCapture = {
  readonly child: ChildProcessEpoch;
  readonly group: ProcessGroupEpoch | undefined;
};
export type ProcessEpochReader = {
  /** The pid hint exists only to make the test reader seam precise. */
  readonly snapshot: (pidHint?: number) => readonly ProcessEpochRow[] | undefined;
};

const systemReader: ProcessEpochReader = {
  snapshot: () => {
    try {
      // `lstart` is deliberately last: its whitespace is part of the stable key.
      const result = spawnSync("ps", ["-axo", "pid=,pgid=,sess=,lstart="], { encoding: "utf8", timeout: 500 });
      if (result.status !== 0) return undefined;
      return (result.stdout ?? "").split("\n").flatMap((line) => {
        const match = line.match(/^\s*([1-9][0-9]*)\s+([1-9][0-9]*)\s+(0|[1-9][0-9]*)\s+(.+?)\s*$/);
        return match ? [{ pid: Number(match[1]), processGroupId: Number(match[2]), sessionId: Number(match[3]), startKey: match[4]! }] : [];
      });
    } catch { return undefined; }
  },
};

let reader: ProcessEpochReader = systemReader;

/** Capture exact-child and optional group-leader identity from one table read. */
export const captureProcessEpoch = (pid: number): ProcessEpochCapture | undefined => {
  const row = reader.snapshot(pid)?.find((candidate) => candidate.pid === pid);
  if (!row) return undefined;
  return {
    child: { pid: row.pid, startKey: row.startKey },
    group: row.processGroupId === pid
      ? { processGroupId: row.processGroupId, sessionId: row.sessionId, startKey: row.startKey }
      : undefined,
  };
};

export const captureChildProcessEpoch = (pid: number): ChildProcessEpoch | undefined =>
  captureProcessEpoch(pid)?.child;

/** Revalidate one exact numeric child from one fresh table snapshot. */
export const childProcessEpochIsCurrent = (pid: number, epoch: ChildProcessEpoch): boolean => {
  if (epoch.pid !== pid) return false;
  const row = reader.snapshot(pid)?.find((candidate) => candidate.pid === pid);
  return row !== undefined && row.startKey === epoch.startKey;
};

export const captureProcessGroupEpoch = (pid: number): ProcessGroupEpoch | undefined => {
  return captureProcessEpoch(pid)?.group;
};

/** Authorize from exactly one coherent table snapshot. */
export const processGroupEpochIsCurrent = (pid: number, epoch: ProcessGroupEpoch): boolean => {
  const snapshot = reader.snapshot(pid);
  if (!snapshot) return false;
  const leader = snapshot.find((row) => row.pid === pid);
  return leader !== undefined
    && leader.processGroupId === pid
    && leader.sessionId === epoch.sessionId
    && leader.startKey === epoch.startKey;
};

/** Test-only observation seam; it cannot mint or signal process authority. */
export const setProcessEpochReaderForTests = (next: ProcessEpochReader | undefined): void => { reader = next ?? systemReader; };
