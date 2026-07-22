import { spawnSync } from "node:child_process";

/** One row from one `ps` observation; never compose identity from multiple reads. */
export type ProcessEpochRow = {
  readonly pid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startKey: string;
};

export type ProcessGroupEpoch = Pick<ProcessEpochRow, "processGroupId" | "sessionId" | "startKey">;
export type ProcessEpochReader = { readonly snapshot: () => readonly ProcessEpochRow[] | undefined };

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

export const captureProcessGroupEpoch = (pid: number): ProcessGroupEpoch | undefined => {
  const leader = reader.snapshot()?.find((row) => row.pid === pid);
  return leader && leader.processGroupId === pid
    ? { processGroupId: leader.processGroupId, sessionId: leader.sessionId, startKey: leader.startKey }
    : undefined;
};

/** Authorize from exactly one coherent table snapshot. */
export const processGroupEpochIsCurrent = (pid: number, epoch: ProcessGroupEpoch): boolean => {
  const snapshot = reader.snapshot();
  if (!snapshot) return false;
  const leader = snapshot.find((row) => row.pid === pid);
  return leader !== undefined
    && leader.processGroupId === pid
    && leader.sessionId === epoch.sessionId
    && leader.startKey === epoch.startKey;
};

/** Test-only observation seam; it cannot mint or signal process authority. */
export const setProcessEpochReaderForTests = (next: ProcessEpochReader | undefined): void => { reader = next ?? systemReader; };
