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
 *   /Users/<me>/Projects/vellum  ->  -Projects-vellum
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

/** `<ISO-ish timestamp>_<uuid>.jsonl`, e.g. `2026-08-28T09-18-18-179Z_01a047a9-…`. */
const OMP_SESSION_FILE =
  /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * The id a seat stores and later resumes with.
 *
 * omp resumes on an id PREFIX, and the uuid is what identifies the session, so
 * that is what is kept — not the filename, which carries a timestamp that adds
 * nothing to `--resume`.
 */
export const isOmpSessionId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );

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
    // leading dash (`/Projects/vellum` -> `-Projects-vellum`).
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

export type OmpDiscoveryInput = {
  readonly cwd: string;
  readonly spawnedAtMs: number;
  readonly home: string;
  readonly graceMs?: number;
  /** Defaults to `os.tmpdir()`, matching installed omp. */
  readonly tmpDir?: string;
};

const DEFAULT_GRACE_MS = 2_000;

/**
 * The session this seat started, or undefined while omp has written none.
 *
 * The workspace is already proven by the directory, so the only remaining
 * question is time: a file written before this seat spawned belongs to an
 * earlier one. Newest wins among those that pass.
 */
export const discoverOmpSessionId = (
  input: OmpDiscoveryInput,
): string | undefined => {
  const dir = ompSessionsDir(input.cwd, input.home, input.tmpDir);
  const floor = input.spawnedAtMs - (input.graceMs ?? DEFAULT_GRACE_MS);
  let names: readonly string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { readonly id: string; readonly mtimeMs: number } | undefined;
  for (const name of names) {
    const match = OMP_SESSION_FILE.exec(name);
    if (!match) continue;
    let mtimeMs: number;
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) continue;
      mtimeMs = stat.birthtimeMs || stat.mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < floor) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { id: match[2]!, mtimeMs };
  }
  return best?.id;
};
