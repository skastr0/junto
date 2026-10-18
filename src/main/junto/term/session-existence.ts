/**
 * External harness-session proof for cold resume.
 *
 * Proof is filesystem (or future CLI) evidence only — never Junto's
 * process-local capture cache or canvas mint. Absence or IO failure is
 * not-proven (fail-open to pin / fresh session).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { stripIdlessSessionContinue } from "@shared/managed-terminal-launch";
import { withReadOnlyDatabase } from "./read-only-sqlite";
import {
  ampDocumentUsage,
  claudeUsage,
  codexUsage,
  grokUsage,
  kimiUsage,
  museUsage,
  piUsage,
  type UsageReader,
} from "./session-usage";
import { AGY_SPAWNED_SESSIONS } from "./templates/agy-session";
import { CODEX_SPAWNED_SESSIONS, isCodexSessionId } from "./templates/codex-session";
import { FX_SPAWNED_SESSIONS, isFxSessionId } from "./templates/fx-session";
import { MUSE_SPAWNED_SESSIONS } from "./templates/muse-session";
import { isOmpSessionId, OMP_SPAWNED_SESSIONS, ompSessionsDir } from "./templates/omp-session";
import type { SpawnedSessionStore } from "./templates/spawned-session";
import {
  HARNESS_IDS,
  isHarnessId,
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";

export type SessionExistenceProbe = {
  readonly harness: string;
  readonly sessionId: string;
  readonly cwd?: string;
  /** Override home for tests. */
  readonly home?: string;
};

/** Test-only home root for FS probes (not a session-existence cache). */
let homeForTest: string | undefined;
export const __setSessionExistenceHomeForTest = (home: string | undefined): void => {
  homeForTest = home;
};

const resolveHome = (home?: string): string => home ?? homeForTest ?? homedir();

/** Grok stores sessions under ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/. */
export const encodeGrokSessionCwd = (cwd: string): string =>
  encodeURIComponent(resolve(cwd));

/** Claude project dir: /Users/foo/bar → -Users-foo-bar */
export const encodeClaudeProjectCwd = (cwd: string): string =>
  resolve(cwd).replace(/\//g, "-");

/** Cursor project dir: /Users/foo/bar → Users-foo-bar (no leading dash). */
export const encodeCursorProjectCwd = (cwd: string): string =>
  resolve(cwd).replace(/^\//, "").replace(/\//g, "-");

/**
 * Pi cwd encoding for the session dir: strip leading "/", map "/" and ":" to
 * "-", wrap in "--…--". /Users/me/proj → --Users-me-proj--
 */
export const encodePiSessionCwd = (cwd: string): string => {
  const absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
  return `--${absolute.replace(/^\//, "").replace(/[/:]/g, "-")}--`;
};

/**
 * Hermes session ids are `%Y%m%d_%H%M%S_<hex6>` — the same value the harness
 * exports as `HERMES_SESSION_ID` into the agent shell. Shape-checking before
 * the query keeps scraped PTY text from reaching the database at all.
 */
export const isHermesSessionId = (value: string): boolean =>
  /^\d{8}_\d{6}_[0-9a-f]{6}$/i.test(value.trim());

/** Amp thread ids are `T-<uuid>`. */
const isAmpThreadId = (value: string): boolean =>
  /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// ── Session stores ─────────────────────────────────────────────────────────

/** Where a probe looks from. `pinned` is true when the caller fixed the home (tests). */
export type SessionWhere = {
  readonly home: string;
  readonly cwd?: string;
  readonly pinned: boolean;
};

/**
 * What proves a session inside one directory. Matches are tried in order; the
 * first that answers is the session's location.
 * - file / dir: a path under the directory, built from the id. A dir may need
 *   a file inside it, or any entry at all.
 * - entryIncludes: a direct entry whose name contains the id.
 * - treeIncludes: any entry, at most `depth` levels down, whose name contains
 *   the id (rollout names embed it).
 * - dirNamed: a directory named exactly the id, at most `depth` levels down.
 * - database: a read-only query on the harness's own database; the first
 *   statement that prepares decides, so a column rename degrades to the next.
 */
export type SessionMatch =
  | { readonly kind: "file"; readonly path: (id: string) => readonly string[] }
  | {
      readonly kind: "dir";
      readonly path: (id: string) => readonly string[];
      readonly holds?: readonly string[];
      readonly nonEmpty?: boolean;
    }
  | { readonly kind: "entryIncludes"; readonly files: boolean }
  | { readonly kind: "treeIncludes"; readonly depth: number }
  | { readonly kind: "dirNamed"; readonly depth: number }
  | { readonly kind: "database"; readonly file: string; readonly statements: readonly string[] };

/**
 * One directory the store keeps sessions in, under its root. `children`
 * looks in every child directory (an encoded cwd or a workspace key), the
 * cwd's own child first when the store can name it.
 */
export type SessionPlace = {
  readonly under?: readonly string[];
  readonly scope: { readonly kind: "self" } | { readonly kind: "children"; readonly cwdChild?: (cwd: string) => string };
  readonly match: readonly SessionMatch[];
};

/** How big a located session is (see `session-size.ts`). */
export type SessionSizeSpec = {
  /** Transcript bytes per context token, for the `estimated` basis. */
  readonly bytesPerToken: number;
  /** Byte-count queries, used when the session was located in a database. */
  readonly database?: readonly string[];
  /** Where the harness records its own token counts. */
  readonly usage?:
    | { readonly kind: "jsonl"; readonly read: UsageReader; readonly sibling?: string }
    | { readonly kind: "document"; readonly read: (tail: string) => number | undefined };
};

/** A harness's session store: where its sessions live and how one is proven. */
export type HarnessSessionStore = {
  readonly root: (where: SessionWhere) => string | undefined;
  /** Ids of any other shape are never looked up. */
  readonly idShape?: (id: string) => boolean;
  readonly places: readonly SessionPlace[];
  /** The conversation file inside a located session folder. */
  readonly transcriptInside?: readonly string[];
  /** Undefined when what is located is not the conversation. */
  readonly size?: SessionSizeSpec;
  /**
   * How a seat finds the session this harness minted after spawn, for a
   * harness that never prints its id and cannot be told one.
   */
  readonly spawned?: SpawnedSessionStore;
};

/**
 * A root under the home. An env override applies only when the caller did
 * not pin the home, so tests stay hermetic against ambient machine env; the
 * first override set wins.
 */
const homeRoot =
  (segments: readonly string[], overrides: readonly { key: string; then?: readonly string[] }[] = []) =>
  (where: SessionWhere): string => {
    if (!where.pinned) {
      for (const { key, then } of overrides) {
        const value = process.env[key]?.trim();
        if (value) return join(value, ...(then ?? []));
      }
    }
    return join(where.home, ...segments);
  };

const file = (path: (id: string) => readonly string[]): SessionMatch => ({ kind: "file", path });
const dir = (
  path: (id: string) => readonly string[],
  extra: { holds?: readonly string[]; nonEmpty?: boolean } = {},
): SessionMatch => ({ kind: "dir", path, ...extra });
const self = (...match: readonly SessionMatch[]): SessionPlace => ({ scope: { kind: "self" }, match });

/**
 * Hermes: only messages still in the model's context (`active`), so its own
 * compaction is respected. Tried with and without that column, since the
 * schema is the harness's to change.
 */
const HERMES_BYTES_SQL = [
  "SELECT SUM(LENGTH(COALESCE(content,'')) + LENGTH(COALESCE(tool_calls,'')) + LENGTH(COALESCE(reasoning,''))) AS bytes FROM messages WHERE session_id = ? AND COALESCE(active, 1) = 1",
  "SELECT SUM(LENGTH(COALESCE(content,''))) AS bytes FROM messages WHERE session_id = ?",
] as const;

const DEVIN_BYTES_SQL =
  "SELECT SUM(LENGTH(COALESCE(chat_message,''))) AS bytes FROM message_nodes WHERE session_id = ?";

/**
 * Every harness's session store. Byte ratios for formats that also record
 * usage are the median of bytes over recorded context across uncompacted
 * sessions on a development machine (2026-10); the others take the middle of
 * that range. They are estimates, and the settings page should say so.
 */
export const HARNESS_SESSION_STORES: Readonly<Record<HarnessId, HarnessSessionStore | undefined>> = {
  // ~/.grok/sessions/<encoded cwd>/<id>/; the id may live under any cwd.
  // Grok reports its running total beside each update, in a sibling file.
  grok: {
    root: homeRoot([".grok", "sessions"]),
    places: [{ scope: { kind: "children", cwdChild: encodeGrokSessionCwd }, match: [dir((id) => [id])] }],
    transcriptInside: ["chat_history.jsonl"],
    size: { bytesPerToken: 6, usage: { kind: "jsonl", read: grokUsage, sibling: "updates.jsonl" } },
  },
  // The transcript is the jsonl; the id-named directory holds its sidecars.
  claude: {
    root: homeRoot([".claude", "projects"]),
    places: [
      {
        scope: { kind: "children", cwdChild: encodeClaudeProjectCwd },
        match: [file((id) => [`${id}.jsonl`]), dir((id) => [id])],
      },
    ],
    size: { bytesPerToken: 8, usage: { kind: "jsonl", read: claudeUsage } },
  },
  // Codex rollouts embed the thread id in the filename. The name is matched
  // by inclusion, so only a whole id counts: a cut-short one is in some
  // rollout's name too, and proved a session Codex never had.
  codex: {
    root: homeRoot([".codex", "sessions"]),
    idShape: isCodexSessionId,
    places: [self({ kind: "treeIncludes", depth: 6 })],
    size: { bytesPerToken: 5, usage: { kind: "jsonl", read: codexUsage } },
    spawned: CODEX_SPAWNED_SESSIONS,
  },
  /**
   * Hermes sessions live in ONE place: `~/.hermes/state.db`. The jsonl
   * transcripts under `~/.hermes/sessions/` are retired — v0.20.4 writes
   * nothing there, so a filesystem probe would report "not proven" for every
   * live session. The id column has been `id` in every build probed.
   */
  hermes: {
    root: homeRoot([".hermes"]),
    idShape: isHermesSessionId,
    places: [
      self({
        kind: "database",
        file: "state.db",
        statements: [
          "SELECT 1 AS present FROM sessions WHERE id = ? LIMIT 1",
          "SELECT 1 AS present FROM sessions WHERE session_id = ? LIMIT 1",
        ],
      }),
    ],
    // Message text read out of the database, without a transcript's JSON wrapping.
    size: { bytesPerToken: 4, database: HERMES_BYTES_SQL },
  },
  /**
   * Pi: <root>/--<cwd-encoded>--/<ISO-ts>_<uuidv7>.jsonl. Resume accepts
   * partial ids, so a filename containing the id is proof. The root is
   * ~/.pi/agent/sessions; PI_CODING_AGENT_SESSION_DIR replaces it outright and
   * PI_CODING_AGENT_DIR relocates the agent dir.
   */
  pi: {
    root: homeRoot(
      [".pi", "agent", "sessions"],
      [{ key: "PI_CODING_AGENT_SESSION_DIR" }, { key: "PI_CODING_AGENT_DIR", then: ["sessions"] }],
    ),
    places: [
      { scope: { kind: "children", cwdChild: encodePiSessionCwd }, match: [{ kind: "treeIncludes", depth: 6 }] },
    ],
    size: { bytesPerToken: 5, usage: { kind: "jsonl", read: piUsage } },
  },
  /**
   * Prime Agent: ~/.prime/agent/sessions/<uuid>.jsonl (flat). Resume accepts
   * an id prefix or suffix. A session may also own a sidecar folder named by
   * the bare id; the transcript file is preferred, so the answer is what an
   * agent can read.
   */
  "prime-agent": {
    root: homeRoot([".prime", "agent", "sessions"]),
    places: [
      self(file((id) => [`${id}.jsonl`]), { kind: "entryIncludes", files: true }, { kind: "treeIncludes", depth: 6 }),
    ],
    size: { bytesPerToken: 5, usage: { kind: "jsonl", read: piUsage } },
  },
  /**
   * Kimi: $KIMI_CODE_HOME/sessions/<workDirKey>/<id>/, the directory `-S <id>`
   * reads (verified on 0.34.0). The welcome-card `Session:` line is blank at
   * spawn and is never a startup receipt; a later scrape is only stored after
   * this probe succeeds.
   */
  kimi: {
    root: homeRoot([".kimi-code", "sessions"], [{ key: "KIMI_CODE_HOME", then: ["sessions"] }]),
    places: [{ scope: { kind: "children" }, match: [dir((id) => [id])] }],
    transcriptInside: ["agents", "main", "wire.jsonl"],
    size: { bytesPerToken: 5, usage: { kind: "jsonl", read: kimiUsage } },
  },
  // Muse: ~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/.
  muse: {
    root: homeRoot([".local", "share", "muse", "sessions"]),
    places: [self({ kind: "dirNamed", depth: 4 })],
    transcriptInside: ["session.jsonl"],
    size: { bytesPerToken: 13, usage: { kind: "jsonl", read: museUsage } },
    spawned: MUSE_SPAWNED_SESSIONS,
  },
  /**
   * Devin: `~/.local/share/devin/cli/sessions.db`, table `sessions`, keyed by
   * the adjective-noun slug; the database is exactly what `-r` reads.
   * `session_locks/<id>.lock` is NOT proof: locks outlive their sessions, and
   * `devin -r` on a lock-only slug finds nothing. `transcripts/<id>.json` is a
   * legacy fallback that can prove an id but never disprove one.
   */
  devin: {
    root: homeRoot([".local", "share", "devin", "cli"]),
    places: [
      self(file((id) => ["transcripts", `${id}.json`]), {
        kind: "database",
        file: "sessions.db",
        statements: ["SELECT 1 AS present FROM sessions WHERE id = ? LIMIT 1"],
      }),
    ],
    size: { bytesPerToken: 6, database: [DEVIN_BYTES_SQL] },
  },
  /**
   * Cursor. The durable receipt is `chats/<workspaceHash>/<id>/meta.json`,
   * written once the session has a first turn, and checked first because it is
   * the path re-probed live (2026-08-25). `projects/<sanitized>/agent-transcripts/`
   * is a second look for older layouts. A pinned id with no turn yet is not
   * proven, and rightly: the spawn creates the session with that same id.
   * CURSOR_DATA_DIR replaces ~/.cursor. Its store.db is a content-addressed
   * blob store, not the conversation, so it has no size.
   */
  cursor: {
    root: homeRoot([".cursor"], [{ key: "CURSOR_DATA_DIR" }]),
    places: [
      { under: ["chats"], scope: { kind: "children" }, match: [dir((id) => [id], { holds: ["meta.json"] })] },
      {
        under: ["projects"],
        scope: { kind: "children", cwdChild: encodeCursorProjectCwd },
        match: [
          dir((id) => ["agent-transcripts", id]),
          file((id) => ["agent-transcripts", `${id}.jsonl`]),
        ],
      },
    ],
    transcriptInside: ["store.db"],
  },
  // Antigravity: ~/.gemini/antigravity-cli/brain/<id>/, its transcript or any entry.
  agy: {
    root: homeRoot([".gemini", "antigravity-cli", "brain"]),
    places: [
      self(
        file((id) => [id, ".system_generated", "logs", "transcript.jsonl"]),
        dir((id) => [id], { nonEmpty: true }),
      ),
    ],
    size: { bytesPerToken: 6 },
    spawned: AGY_SPAWNED_SESSIONS,
  },
  /**
   * Amp threads live on Amp's server; one that ran on this machine has a local
   * copy at ~/.local/share/amp/threads/<T-id>.json, the only transcript there
   * is. Never resume proof: Amp's thread is provisioned through its own CLI.
   */
  amp: {
    root: homeRoot([".local", "share", "amp", "threads"]),
    idShape: isAmpThreadId,
    places: [self(file((id) => [`${id}.json`]))],
    size: { bytesPerToken: 6, usage: { kind: "document", read: ampDocumentUsage } },
  },
  /**
   * fx: ~/.fx/sessions/<id>/, flat. An id captured from the index still has to
   * exist on disk. Its events.jsonl repeats every streamed chunk, so it is not
   * the conversation and has no size.
   */
  fx: {
    root: homeRoot([".fx", "sessions"]),
    idShape: isFxSessionId,
    places: [self(dir((id) => [id]))],
    transcriptInside: ["events.jsonl"],
    spawned: FX_SPAWNED_SESSIONS,
  },
  // Oh My Pi: one jsonl per session under the encoded-cwd directory, which IS the workspace.
  omp: {
    root: (where) => (where.cwd ? ompSessionsDir(where.cwd, where.home) : undefined),
    idShape: isOmpSessionId,
    places: [self({ kind: "entryIncludes", files: false })],
    size: { bytesPerToken: 5, usage: { kind: "jsonl", read: piUsage } },
    spawned: OMP_SPAWNED_SESSIONS,
  },
  "junto-overseer": undefined,
};

export const sessionStoreFor = (harness: string): HarnessSessionStore | undefined =>
  isHarnessId(harness) ? HARNESS_SESSION_STORES[harness] : undefined;

const isDir = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

const entriesOf = (path: string): readonly string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

const treeIncludes = (path: string, id: string, depth: number, maxDepth: number): string | undefined => {
  if (depth > maxDepth) return undefined;
  for (const name of entriesOf(path)) {
    const child = join(path, name);
    if (name.includes(id)) return child;
    if (isDir(child)) {
      const found = treeIncludes(child, id, depth + 1, maxDepth);
      if (found) return found;
    }
  }
  return undefined;
};

const dirNamed = (path: string, id: string, depth: number, maxDepth: number): string | undefined => {
  if (depth > maxDepth) return undefined;
  for (const name of entriesOf(path)) {
    const child = join(path, name);
    if (!isDir(child)) continue;
    if (name === id) return child;
    const found = dirNamed(child, id, depth + 1, maxDepth);
    if (found) return found;
  }
  return undefined;
};

const matchIn = (path: string, id: string, match: SessionMatch): string | undefined => {
  switch (match.kind) {
    case "file": {
      const candidate = join(path, ...match.path(id));
      return isFile(candidate) ? candidate : undefined;
    }
    case "dir": {
      const candidate = join(path, ...match.path(id));
      if (!isDir(candidate)) return undefined;
      if (match.holds && !isFile(join(candidate, ...match.holds))) return undefined;
      if (match.nonEmpty && entriesOf(candidate).length === 0) return undefined;
      return candidate;
    }
    case "entryIncludes": {
      const name = entriesOf(path).find(
        (entry) => entry.includes(id) && (!match.files || isFile(join(path, entry))),
      );
      return name === undefined ? undefined : join(path, name);
    }
    case "treeIncludes":
      return treeIncludes(path, id, 0, match.depth);
    case "dirNamed":
      return dirNamed(path, id, 0, match.depth);
    case "database": {
      const database = join(path, match.file);
      if (!isFile(database)) return undefined;
      const present = withReadOnlyDatabase(database, (db) => {
        for (const sql of match.statements) {
          try {
            return db.prepare(sql).get(id) !== undefined;
          } catch {
            // try the next statement
          }
        }
        return undefined;
      });
      return present === true ? database : undefined;
    }
  }
};

const firstMatch = (path: string, id: string, matches: readonly SessionMatch[]): string | undefined => {
  for (const match of matches) {
    const found = matchIn(path, id, match);
    if (found) return found;
  }
  return undefined;
};

const locateIn = (root: string, place: SessionPlace, id: string, cwd: string | undefined): string | undefined => {
  const base = join(root, ...(place.under ?? []));
  if (!isDir(base)) return undefined;
  if (place.scope.kind === "self") return firstMatch(base, id, place.match);
  if (cwd && cwd.trim() && place.scope.cwdChild) {
    const found = firstMatch(join(base, place.scope.cwdChild(cwd)), id, place.match);
    if (found) return found;
  }
  for (const child of entriesOf(base)) {
    const found = firstMatch(join(base, child), id, place.match);
    if (found) return found;
  }
  return undefined;
};

/**
 * Where the harness keeps this session on disk: the transcript file or session
 * directory an agent can open itself, or the harness's own session database
 * when that is the only record (Hermes, Devin). The same probe as
 * `harnessSessionExists`, which is this locator answering at all. Errors and
 * missing trees return undefined (not found).
 */
export const harnessSessionLocation = (
  probe: SessionExistenceProbe,
): string | undefined => {
  const sessionId = probe.sessionId.trim();
  if (!sessionId) return undefined;
  const store = sessionStoreFor(probe.harness.trim());
  if (store === undefined) return undefined;
  if (store.idShape && !store.idShape(sessionId)) return undefined;
  try {
    const root = store.root({
      home: resolveHome(probe.home),
      ...(probe.cwd === undefined ? {} : { cwd: probe.cwd }),
      pinned: probe.home !== undefined || homeForTest !== undefined,
    });
    if (root === undefined) return undefined;
    for (const place of store.places) {
      const found = locateIn(root, place, sessionId, probe.cwd);
      if (found) return found;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * True when harness-local durable state for this session id is present.
 * Errors and missing trees return false (not proven).
 */
export const harnessSessionExists = (probe: SessionExistenceProbe): boolean =>
  harnessSessionLocation(probe) !== undefined;

/**
 * Resume argv is allowed only when the caller wants resume AND external proof
 * confirms the id. Unproven → pin/create path (fail open).
 */
export const shouldResumeHarnessSession = (
  wantResume: boolean,
  probe: SessionExistenceProbe,
): boolean => wantResume && harnessSessionExists(probe);

/**
 * Harness-printed resume failure (Grok remote 404, missing Claude session, …).
 * Used for fail-open: abandon -r and open a fresh pin session.
 */
export const isHarnessResumeFailureText = (text: string): boolean => {
  const t = text.toLowerCase();
  if (!t) return false;
  if (t.includes("failed to restore session")) return true;
  if (t.includes("session get failed")) return true;
  if (t.includes("no conversation found") && t.includes("resume")) return true;
  if (t.includes("session not found") && (t.includes("resume") || t.includes("restore"))) {
    return true;
  }
  // Devin: "Error: No session found matching 'ionized-pluto'" (3000.4.16).
  if (t.includes("no session found matching")) return true;
  // Grok: "fetching session record: session get failed: 404 Not Found"
  if (t.includes("fetching session record") && t.includes("404")) return true;
  if (t.includes("resume") && t.includes("404") && t.includes("not found")) return true;
  // Grok pin-create against a session this station already made.
  if (t.includes("already in use") && t.includes("session")) return true;
  return false;
};

/**
 * The pin harnesses: those whose template declares a `sessionIdFlag`, so
 * their session id can be read back off spawn argv. Each harness's binary
 * comes from its template rather than a second list, so renaming a CLI cannot
 * leave a stale name behind: Cursor's moved from the `agent` compatibility
 * alias to its own `cursor-agent`.
 */
const PIN_HARNESSES: readonly HarnessId[] = HARNESS_IDS.filter(
  (harness) => templateFor(harness).argvSpec.sessionIdFlag !== undefined,
);

export type HarnessSessionArgv = {
  readonly harness: HarnessId;
  readonly sessionId: string;
  readonly mode: "pin" | "resume";
};

const pinHarnessFromBinary = (
  file: string | undefined,
): HarnessSessionArgv["harness"] | undefined => {
  if (!file) return undefined;
  const name = basename(file);
  for (const harness of PIN_HARNESSES) {
    if (templateFor(harness).argvSpec.binary === name) return harness;
  }
  return undefined;
};

/**
 * The harness's own named-resume flag, read from its template so this low-level
 * reclaim path cannot drift from the shape `buildArgv` emits.
 *
 * It drifted once: every harness but Claude got `-r`, and on Pi `-r`
 * (`--resume`) means "Select a session to resume" — the interactive picker,
 * verified on 0.84.2 — so a reclaimed seat opened a menu instead of its own
 * session. Pi's named form is `--session <path|id>`, which the template
 * already declared.
 */
const resumeFlagFor = (harness: HarnessSessionArgv["harness"]): string =>
  templateFor(harness).argvSpec.resumeFlag ?? "-r";

/**
 * The token that CREATES a named session for this harness, read from the
 * template rather than assumed: `--session-id` for claude/grok/pi,
 * `--new-session-id` for cursor.
 */
const pinFlagFor = (
  harness: HarnessSessionArgv["harness"],
): string | undefined => templateFor(harness).argvSpec.sessionIdFlag;

/**
 * Named-resume tokens across the pin harnesses: `-r` / `--resume` (grok,
 * claude) and Pi's `--session`. `--session-id` and `--session-dir` are NOT
 * resume — the first is a pin that creates the session if missing, the second
 * is storage configuration — so this matches whole tokens only.
 */
const isNamedResumeToken = (token: string): boolean =>
  token === "-r" || token === "--resume" || token === "--session";

/** Read pin/resume id from spawn argv. Pin is create; resume is reclaim. */
export const parseHarnessSessionArgv = (
  argv: ReadonlyArray<string>,
): HarnessSessionArgv | undefined => {
  const harness = pinHarnessFromBinary(argv[0]);
  if (!harness) return undefined;
  const pinFlag = pinFlagFor(harness);
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (isNamedResumeToken(tok)) {
      const id = argv[i + 1];
      if (id && !id.startsWith("-")) {
        return { harness, sessionId: id, mode: "resume" };
      }
    }
    if (pinFlag) {
      if (tok === pinFlag) {
        const id = argv[i + 1];
        if (id && !id.startsWith("-")) {
          return { harness, sessionId: id, mode: "pin" };
        }
      }
      if (tok.startsWith(`${pinFlag}=`)) {
        const id = tok.slice(pinFlag.length + 1);
        if (id) return { harness, sessionId: id, mode: "pin" };
      }
    }
  }
  return undefined;
};

/**
 * This host created the harness session. After a station restart the in-memory
 * seat table is empty, but the session files remain. Keep this as a defense for
 * lower-level/raw pin argv: convert a locally proven orphaned pin to resume so
 * the host reclaims rather than duplicates it. Actor occupation now resolves
 * named-session intent on this host before reaching this fallback.
 */
export const reclaimOrphanedHarnessArgv = (
  argv: ReadonlyArray<string>,
  cwd?: string,
): string[] => {
  const parsed = parseHarnessSessionArgv(argv);
  if (!parsed || parsed.mode === "resume") {
    return stripIdlessSessionContinue(argv);
  }
  if (
    !harnessSessionExists({
      harness: parsed.harness,
      sessionId: parsed.sessionId,
      ...(cwd === undefined ? {} : { cwd }),
    })
  ) {
    return stripIdlessSessionContinue(argv);
  }
  const out = [...argv];
  const resumeFlag = resumeFlagFor(parsed.harness);
  const pinFlag = pinFlagFor(parsed.harness);
  if (!pinFlag) return stripIdlessSessionContinue(out);
  for (let i = 1; i < out.length; i += 1) {
    if (out[i] === pinFlag && out[i + 1] === parsed.sessionId) {
      out[i] = resumeFlag;
      return stripIdlessSessionContinue(out);
    }
    if (out[i] === `${pinFlag}=${parsed.sessionId}`) {
      out.splice(i, 1, resumeFlag, parsed.sessionId);
      return stripIdlessSessionContinue(out);
    }
  }
  return stripIdlessSessionContinue(out);
};

export const launchArgvUsesResume = (
  argv: ReadonlyArray<string> | undefined,
): boolean => {
  if (!argv || argv.length === 0) return false;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    // Pi's `--session <id>` is a resume as much as `-r` is; missing it left the
    // isolation guard and the dead-resume fail-open blind to every Pi resume.
    if (isNamedResumeToken(tok)) return true;
    if (tok === "resume" && i > 0) return true;
  }
  return false;
};

/**
 * Pin harnesses that mint a UUID at node create. Pi pins via `--session-id`,
 * Cursor via `--new-session-id`.
 */
export const isPinSessionHarness = (harness: string): boolean =>
  isHarnessId(harness) && PIN_HARNESSES.includes(harness);

export type { HarnessId };
