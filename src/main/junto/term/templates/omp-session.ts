/**
 * Oh My Pi session discovery.
 *
 * omp mints its session id and never prints it, so a seat finds its own the way
 * Muse and fx seats do — except omp needs no workspace field, because the
 * workspace IS the directory the session file lives in:
 *
 *   ~/.omp/agent/sessions/<encoded-cwd>/<ISO-ts>_<uuidv7>.jsonl
 *
 * Installed 18.1.16 `session-paths.ts` names the directory three ways:
 *
 *   /Users/<me>/Projects/junto  ->  -Projects-junto
 *   <os.tmpdir()>/seat           ->  -tmp-seat
 *   /private/tmp/omp-probe       ->  --private-tmp-omp-probe--
 *
 * Home-relative is `/`→`-` with a leading dash. A cwd under `os.tmpdir()`
 * is `-tmp-` plus the tmp-relative remainder. Anything else drops its
 * leading slash, turns `/` into `-`, and wraps in `--` … `--`. This
 * machine's tmpdir is `/var/folders/…/T`, so the 18.0.9
 * `/private/tmp/omp-probe` tree stays the abs wrap.
 *
 * Read-only: one readdir of one directory, no writes under ~/.omp.
 */

import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSpawnedSession,
  isUuid,
  UUID_PATTERN,
  type SpawnedSessionCandidate,
  type SpawnedSessionInput,
  type SpawnedSessionStore,
} from "./spawned-session";

/** `<ISO-ish timestamp>_<uuid>.jsonl`, e.g. `2026-08-28T09-18-18-179Z_01a047a9-…`. */
const OMP_SESSION_FILE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z)_(${UUID_PATTERN})\\.jsonl$`, "i");

/**
 * The id a seat stores and later resumes with.
 *
 * omp resumes on an id PREFIX, and the uuid is what identifies the session, so
 * that is what is kept — not the filename, which carries a timestamp that adds
 * nothing to `--resume`.
 */
export const isOmpSessionId = isUuid;

/** How omp names the directory holding one workspace's sessions. */
export const encodeOmpWorkspaceDir = (
  cwd: string,
  home: string,
  tmpRoot: string = tmpdir(),
): string => {
  const path = cwd.replace(/\/+$/, "");
  const root = home.replace(/\/+$/, "");
  const temp = tmpRoot.replace(/\/+$/, "");
  if (root && (path === root || path.startsWith(`${root}/`))) {
    // Home-relative: the remainder keeps its leading slash, which becomes the
    // leading dash (`/Projects/junto` -> `-Projects-junto`).
    return path.slice(root.length).replaceAll("/", "-");
  }
  if (temp && (path === temp || path.startsWith(`${temp}/`))) {
    // Tmp-relative: `-tmp` plus the remainder (`/T/seat` -> `-tmp-seat`).
    return `-tmp${path.slice(temp.length).replaceAll("/", "-")}`;
  }
  // `--` + the path with its leading slash dropped + `--`.
  return `--${path.replace(/^\/+/, "").replaceAll("/", "-")}--`;
};

export const ompSessionsDir = (
  cwd: string,
  home: string,
  tmpRoot: string = tmpdir(),
): string =>
  join(
    home,
    ".omp",
    "agent",
    "sessions",
    encodeOmpWorkspaceDir(cwd, home, tmpRoot),
  );

export type OmpDiscoveryInput = SpawnedSessionInput;

/**
 * Oh My Pi's store: the workspace is already proven by the directory, so the
 * only remaining question is time. Newest wins among those that pass.
 */
export const OMP_SPAWNED_SESSIONS: SpawnedSessionStore = {
  isSessionId: isOmpSessionId,
  sameWorkspace: "exact",
  pick: "newest",
  scan: ({ home, cwd, tmpDir }) => {
    const dir = ompSessionsDir(cwd, home, tmpDir);
    let names: readonly string[];
    try {
      names = readdirSync(dir);
    } catch {
      return { candidates: [], workspace: "scoped" };
    }
    const candidates: SpawnedSessionCandidate[] = [];
    for (const name of names) {
      const match = OMP_SESSION_FILE.exec(name);
      if (!match) continue;
      try {
        const stat = statSync(join(dir, name));
        if (!stat.isFile()) continue;
        candidates.push({ id: match[2]!, startedAtMs: stat.birthtimeMs || stat.mtimeMs });
      } catch {
        continue;
      }
    }
    return { candidates, workspace: "scoped" };
  },
};

/** The session this seat started, or undefined while omp has written none. */
export const discoverOmpSessionId = (input: OmpDiscoveryInput): string | undefined =>
  discoverSpawnedSession(OMP_SPAWNED_SESSIONS, input);
