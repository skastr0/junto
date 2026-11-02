/**
 * The two facts about a process that need no registry: its start key, and the
 * sentence a caller hears once its seat has moved on.
 *
 * They live apart from process-identity.ts on purpose. That module holds the
 * map of processes this process started, and the map is the core's: the
 * terminal plane runs there, so main links this module for a pure read and a
 * constant, and never the map.
 */
import {
  readSingleProcessEpochSnapshot,
  readSingleProcessEpochSnapshotAsync,
} from "./process-epoch";

/** The start key that tells a live process from a later one with the same pid. */
export const readProcessStartKey = (pid: number): string | undefined => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const startKey = readSingleProcessEpochSnapshot(pid)?.find((row) => row.pid === pid)?.startKey;
  return startKey === undefined || startKey.length === 0 ? undefined : startKey;
};

/**
 * The same answer, asked without holding the caller's thread for a `ps` fork.
 * A seat start needs the binding before it hands the seat out, not before it
 * continues.
 */
export const readProcessStartKeyAsync = async (pid: number): Promise<string | undefined> => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const rows = await readSingleProcessEpochSnapshotAsync(pid);
  const startKey = rows?.find((row) => row.pid === pid)?.startKey;
  return startKey === undefined || startKey.length === 0 ? undefined : startKey;
};

/**
 * What a caller hears once its seat has moved on to a fresh session and it is
 * only being allowed to finish its turn.
 */
export const OFFBOARDED_SESSION_MESSAGE =
  "This session has offboarded. Its seat has moved on to a fresh session.";
