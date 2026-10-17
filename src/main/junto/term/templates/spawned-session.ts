/**
 * Finding the session a harness minted after the seat spawned.
 *
 * Codex, Muse, fx, Oh My Pi and Antigravity mint their own session id and
 * never print it, so a seat finds its own in the harness's session store. The
 * rule is the same for all of them; only reading the store differs:
 *
 * - A session started before the spawn, less a small grace for the gap
 *   between recording the spawn and the harness writing its store, belongs to
 *   an earlier seat. The grace is small on purpose: a wide window is how a
 *   seat steals the session of the seat that started just before it.
 * - A session from another workspace is never this seat's.
 * - An excluded id (this seat's own draining session) is never taken.
 * - Among the rest, the store says how to choose: the earliest, the newest,
 *   or only when exactly one remains. Ties go to the first one read.
 *
 * Undefined is the normal early answer: these harnesses write their store
 * asynchronously, so callers retry on the seat's own boundaries.
 */
import { realpathSync } from "node:fs";

export const SESSION_DISCOVERY_GRACE_MS = 2_000;

/** The UUID shape most of these harnesses mint, unanchored, for ids inside a name. */
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_PATTERN}$`, "i");

export const isUuid = (value: string): boolean => UUID.test(value.trim());

export type SpawnedSessionCandidate = {
  readonly id: string;
  readonly startedAtMs: number;
  /** The workspace the store recorded for the session, when it records one. */
  readonly workspace?: string;
};

/**
 * What one read of the store found.
 * - recorded: each candidate's workspace must be the seat's.
 * - ifRecorded: checked only where the store recorded one.
 * - scoped: the store was read inside the seat's workspace already, or
 *   cannot say which workspace a session is; the store's pick must then be
 *   strict enough on its own.
 */
export type SpawnedSessionScan = {
  readonly candidates: readonly SpawnedSessionCandidate[];
  readonly workspace: "recorded" | "ifRecorded" | "scoped";
};

export type SpawnedSessionWhere = {
  readonly home: string;
  readonly cwd: string;
  /** No session started before this can be the seat's; a scan may skip reading those. */
  readonly floorMs: number;
  readonly nowMs: number;
  readonly tmpDir?: string;
};

export type SpawnedSessionStore = {
  readonly scan: (where: SpawnedSessionWhere) => SpawnedSessionScan;
  /** How a recorded workspace is compared with the seat's cwd. */
  readonly sameWorkspace: "exact" | "trimmed" | "real";
  readonly pick: "earliest" | "newest" | "unique";
  /** A stored id this store could have minted. */
  readonly isSessionId: (value: string) => boolean;
};

export type SpawnedSessionInput = {
  /** The seat's working directory. */
  readonly cwd: string;
  /** Epoch ms the seat's PTY spawned. */
  readonly spawnedAtMs: number;
  readonly home: string;
  readonly nowMs?: number;
  readonly graceMs?: number;
  /** Where the harness thinks the OS temp directory is (Oh My Pi encodes it). */
  readonly tmpDir?: string;
  /** Session ids that are known not to be this seat's (a draining session). */
  readonly exclude?: ReadonlySet<string>;
};

const trimmed = (path: string): string => path.replace(/\/+$/, "");

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return trimmed(path);
  }
};

const workspaceKey = (how: SpawnedSessionStore["sameWorkspace"], path: string): string =>
  how === "exact" ? path : how === "trimmed" ? trimmed(path) : real(path);

export const discoverSpawnedSession = (
  store: SpawnedSessionStore,
  input: SpawnedSessionInput,
): string | undefined => {
  const floorMs = input.spawnedAtMs - (input.graceMs ?? SESSION_DISCOVERY_GRACE_MS);
  const scan = store.scan({
    home: input.home,
    cwd: input.cwd,
    floorMs,
    nowMs: input.nowMs ?? Date.now(),
    ...(input.tmpDir === undefined ? {} : { tmpDir: input.tmpDir }),
  });
  const cwd = workspaceKey(store.sameWorkspace, input.cwd);
  const inWorkspace = (candidate: SpawnedSessionCandidate): boolean => {
    switch (scan.workspace) {
      case "scoped":
        return true;
      case "ifRecorded":
        if (candidate.workspace === undefined || !input.cwd) return true;
        return workspaceKey(store.sameWorkspace, candidate.workspace) === cwd;
      case "recorded":
        return (
          candidate.workspace !== undefined &&
          workspaceKey(store.sameWorkspace, candidate.workspace) === cwd
        );
    }
  };
  const mine = scan.candidates.filter(
    (candidate) =>
      candidate.startedAtMs >= floorMs && !input.exclude?.has(candidate.id) && inWorkspace(candidate),
  );
  if (store.pick === "unique") return mine.length === 1 ? mine[0]!.id : undefined;
  let best: SpawnedSessionCandidate | undefined;
  for (const candidate of mine) {
    if (
      best === undefined ||
      (store.pick === "earliest"
        ? candidate.startedAtMs < best.startedAtMs
        : candidate.startedAtMs > best.startedAtMs)
    ) {
      best = candidate;
    }
  }
  return best?.id;
};
