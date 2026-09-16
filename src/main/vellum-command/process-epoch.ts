import { spawnSync } from "node:child_process";
import { resolveSystemPs } from "./platform-executables";

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
  /**
   * The pid hint is the requested breadth, not a filter suggestion. A hint asks
   * only about that one pid, so the system reader answers it with a single-pid
   * `ps`; no hint asks for the whole table, which only process-group member
   * enumeration needs. A reader may always answer a hinted read with a wider
   * table, which is what the test seam does.
   */
  readonly snapshot: (pidHint?: number) => readonly ProcessEpochRow[] | undefined;
};

/**
 * Closed argument shapes. `ps` arguments are product policy, never caller
 * input: the whole table, or exactly one pid whose digits came from a
 * validated safe integer.
 */
export type ProcessEpochPsArgs =
  | readonly ["-axo", "pid=,pgid=,sess=,lstart="]
  | readonly ["-p", string, "-o", "pid=,pgid=,sess=,lstart="];

export type ProcessEpochPsRequest = {
  readonly command: string;
  readonly args: ProcessEpochPsArgs;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
};

export type ProcessEpochPsResult = {
  readonly status: number | null;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly error?: unknown;
};

export type ProcessEpochPsRunner = (
  request: ProcessEpochPsRequest,
) => ProcessEpochPsResult;

/**
 * Capability-free observation retained after an original process-group leader
 * exits. This is deliberately not a process tree: exact member epochs are
 * learned only while a row is still in the original pgid + session.
 */
export type ProcessGroupObservation = {
  readonly originalProcessGroupId: number;
  readonly sessionId: number;
  readonly observedMemberEpochs: readonly ChildProcessEpoch[];
};

export type ProcessGroupObservationRefresh = {
  readonly observation: ProcessGroupObservation;
  readonly clean: boolean;
};

const PS_TIMEOUT_MS = 500;
const PS_MAX_BUFFER = 16 * 1024 * 1024;
/** One row cannot approach this; a runaway single-pid read fails closed. */
const PS_ROW_MAX_BUFFER = 64 * 1024;
const PS_COLUMNS = "pid=,pgid=,sess=,lstart=" as const;
const PS_FULL_ARGS = ["-axo", PS_COLUMNS] as const;
// `lstart` includes wall-clock time. Pin both locale and timezone so an
// operator timezone change cannot make one live pid look like a new epoch.
const psEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });
const C_LSTART = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+" +
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+" +
  "(?:[1-9]|[12][0-9]|3[01])\\s+" +
  "(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\s+[0-9]{4}";
const PS_ROW = new RegExp(
  `^\\s*([1-9][0-9]*)\\s+(0|[1-9][0-9]*)\\s+(0|[1-9][0-9]*)\\s+(${C_LSTART})\\s*$`,
  "u",
);

const systemPsRunner: ProcessEpochPsRunner = (request) => {
  const result = spawnSync(request.command, [...request.args], {
    encoding: "utf8",
    env: request.env,
    maxBuffer: request.maxBuffer,
    timeout: request.timeoutMs,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : undefined,
    stderr: typeof result.stderr === "string" ? result.stderr : undefined,
    error: result.error,
  };
};

const parseSafeInteger = (value: string, minimum: number): number | undefined => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
};

/**
 * Parse one `ps` body. Every emitted row is fully validated; one malformed
 * nonblank line or one duplicate pid makes the whole observation unavailable.
 */
const parseProcessEpochRows = (
  stdout: string,
): readonly ProcessEpochRow[] | undefined => {
  const rows: ProcessEpochRow[] = [];
  const seenPids = new Set<number>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = PS_ROW.exec(line);
    if (!match) return undefined;
    const pid = parseSafeInteger(match[1]!, 1);
    // Linux exposes kernel threads with PGID/SID 0 in an otherwise complete
    // `ps` table. Preserve those rows as observations so they cannot make the
    // whole snapshot unavailable. Group authority remains positive-only:
    // capture requires processGroupId === the positive child pid.
    const processGroupId = parseSafeInteger(match[2]!, 0);
    const sessionId = parseSafeInteger(match[3]!, 0);
    if (
      pid === undefined ||
      processGroupId === undefined ||
      sessionId === undefined ||
      seenPids.has(pid)
    ) return undefined;
    seenPids.add(pid);
    rows.push({ pid, processGroupId, sessionId, startKey: match[4]! });
  }
  return rows;
};

/**
 * Read and validate one complete process table. Any ambiguity fails closed:
 * non-zero ps, stderr, one malformed nonblank row, duplicate pids, or a table
 * without Junto's own pid witness all make the snapshot unavailable.
 *
 * Reserved for the two callers that must enumerate process-group members. Its
 * cost scales with the machine's process count, so single-pid questions use
 * `readSingleProcessEpochSnapshot` instead.
 */
export const readFullProcessEpochSnapshot = (
  runPs: ProcessEpochPsRunner = systemPsRunner,
  witnessPid: number = process.pid,
): readonly ProcessEpochRow[] | undefined => {
  const ps = resolveSystemPs();
  if (ps === undefined) return undefined;
  let result: ProcessEpochPsResult;
  try {
    result = runPs({
      command: ps,
      args: PS_FULL_ARGS,
      env: psEnv(),
      timeoutMs: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER,
    });
  } catch {
    return undefined;
  }
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.stdout === undefined ||
    (result.stderr ?? "").trim() !== ""
  ) return undefined;

  const rows = parseProcessEpochRows(result.stdout);
  if (rows === undefined) return undefined;
  return rows.some((row) => row.pid === witnessPid) ? rows : undefined;
};

/**
 * Answer one pid's epoch question with a single-pid `ps`, so the cost is the
 * asked-about process rather than the machine's whole process table.
 *
 * Three outcomes, and the difference between the last two is the point:
 * one row (present), `[]` (a clean read proving the pid is absent), and
 * `undefined` (the observation is unavailable and nothing may be concluded).
 *
 * The full table needs Junto's own pid as a witness because `-axo`
 * has no way to say "this table is complete" — a truncated table would read as
 * "the process is gone". A single-pid read replaces that witness with direct
 * evidence and cannot borrow it: macOS `ps` answers a two-pid `-p` list by
 * walking the table anyway, measured at ~285ms against ~2.4ms for one pid.
 * Presence is therefore proven by a parsed row for the exact requested pid;
 * absence is proven only by a run that reported no error, wrote nothing to
 * stderr, exited with a status `ps` uses for "ran fine" (0) or "no matching
 * process" (1), and produced no rows at all. Every other shape is unavailable.
 * A `ps` that reported absence wrongly would still only make callers refuse
 * authority: no caller in this module reads absence as a completed terminate.
 */
export const readSingleProcessEpochSnapshot = (
  pid: number,
  runPs: ProcessEpochPsRunner = systemPsRunner,
): readonly ProcessEpochRow[] | undefined => {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  const ps = resolveSystemPs();
  if (ps === undefined) return undefined;
  let result: ProcessEpochPsResult;
  try {
    result = runPs({
      command: ps,
      args: ["-p", String(pid), "-o", PS_COLUMNS],
      env: psEnv(),
      timeoutMs: PS_TIMEOUT_MS,
      maxBuffer: PS_ROW_MAX_BUFFER,
    });
  } catch {
    return undefined;
  }
  if (
    result.error !== undefined ||
    result.stdout === undefined ||
    (result.stderr ?? "").trim() !== "" ||
    (result.status !== 0 && result.status !== 1)
  ) return undefined;

  const rows = parseProcessEpochRows(result.stdout);
  if (rows === undefined) return undefined;
  if (rows.length === 0) return [];
  // A single-pid query that answered about anything else is incoherent.
  return rows.length === 1 && rows[0]!.pid === pid ? rows : undefined;
};

const systemReader: ProcessEpochReader = {
  snapshot: (pidHint) =>
    pidHint === undefined
      ? readFullProcessEpochSnapshot()
      : readSingleProcessEpochSnapshot(pidHint),
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

const memberIs = (left: ChildProcessEpoch, right: ProcessEpochRow): boolean =>
  left.pid === right.pid && left.startKey === right.startKey;

const unionMemberEpochs = (
  captured: readonly ChildProcessEpoch[],
  current: readonly ProcessEpochRow[],
): readonly ChildProcessEpoch[] => {
  const union = captured.map((member) => ({ ...member }));
  for (const row of current) {
    if (union.some((member) => memberIs(member, row))) continue;
    union.push({ pid: row.pid, startKey: row.startKey });
  }
  return union;
};

/** Seed original-group observation while its leader is still present. */
export const captureProcessGroupObservation = (
  leaderPid: number,
): ProcessGroupObservation | undefined => {
  // Member enumeration is the one question a single-pid read cannot answer.
  const snapshot = reader.snapshot();
  if (!snapshot) return undefined;
  const leader = snapshot.find((candidate) =>
    candidate.pid === leaderPid && candidate.processGroupId === leaderPid
  );
  if (!leader) return undefined;
  const currentMembers = snapshot.filter((candidate) =>
    candidate.processGroupId === leader.processGroupId &&
    candidate.sessionId === leader.sessionId
  );
  return {
    originalProcessGroupId: leader.processGroupId,
    sessionId: leader.sessionId,
    observedMemberEpochs: unionMemberEpochs([], currentMembers),
  };
};

/**
 * Refresh any number of tombstones from one coherent full process table.
 * `undefined` means the table was unavailable and every input stays unclean.
 */
export const refreshProcessGroupObservations = (
  observations: readonly ProcessGroupObservation[],
): readonly ProcessGroupObservationRefresh[] | undefined => {
  if (observations.length === 0) return [];
  const snapshot = reader.snapshot();
  if (!snapshot) return undefined;
  return observations.map((observation) => {
    const currentMembers = snapshot.filter((candidate) =>
      candidate.processGroupId === observation.originalProcessGroupId &&
      candidate.sessionId === observation.sessionId
    );
    const observedMemberEpochs = unionMemberEpochs(
      observation.observedMemberEpochs,
      currentMembers,
    );
    const anyExactMemberRemains = observedMemberEpochs.some((member) =>
      snapshot.some((candidate) => memberIs(member, candidate))
    );
    return {
      clean: currentMembers.length === 0 && !anyExactMemberRemains,
      observation: {
        originalProcessGroupId: observation.originalProcessGroupId,
        sessionId: observation.sessionId,
        observedMemberEpochs,
      },
    };
  });
};

/** Test-only observation seam; it cannot mint or signal process authority. */
export const setProcessEpochReaderForTests = (next: ProcessEpochReader | undefined): void => {
  reader = next ?? systemReader;
};
