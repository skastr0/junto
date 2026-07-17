// Pure browser product logic: session state machine, delete lifecycle,
// profile id validation, URL scheme allowlist.
// No Node, no Electron — unit-tested and shared by main + renderer + CLI.

import { BROWSER_MAX_WARM_SESSIONS_HARD } from "./browser-limits";

export const DEFAULT_BROWSER_PROFILES = ["personal", "work"] as const;
export type DefaultBrowserProfile = (typeof DEFAULT_BROWSER_PROFILES)[number];

/** Profile ids: lowercase slug, 1–63 chars, starts with alnum. */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isValidProfileId = (id: string): boolean => PROFILE_ID_RE.test(id);

export type BrowserSessionState =
  | "idle"
  | "loading"
  | "ready"
  | "failed"
  | "detached"
  | "destroyed";

export type BrowserSessionEvent =
  | { readonly type: "open" }
  | { readonly type: "load_start" }
  | { readonly type: "load_ok"; readonly title?: string }
  | { readonly type: "load_fail"; readonly message: string }
  | { readonly type: "reload" }
  | { readonly type: "detach" }
  | { readonly type: "reattach" }
  | { readonly type: "destroy" };

export interface BrowserSessionMachine {
  readonly state: BrowserSessionState;
  readonly title?: string;
  readonly lastError?: string;
}

export const initialBrowserSession = (): BrowserSessionMachine => ({
  state: "idle",
});

/**
 * Transition table for a warm browser page session (runtime-only).
 * Terminal: destroyed. Detached keeps the warm session without a surface.
 */
export const reduceBrowserSession = (
  machine: BrowserSessionMachine,
  event: BrowserSessionEvent,
): BrowserSessionMachine => {
  if (machine.state === "destroyed") return machine;

  switch (event.type) {
    case "open":
    case "load_start":
    case "reload":
      return { state: "loading", title: machine.title };
    case "load_ok":
      return { state: "ready", title: event.title ?? machine.title };
    case "load_fail":
      return { state: "failed", title: machine.title, lastError: event.message };
    case "detach":
      if (machine.state === "idle") return machine;
      return { ...machine, state: "detached" };
    case "reattach":
      if (machine.state === "detached") {
        return { state: "ready", title: machine.title };
      }
      return machine;
    case "destroy":
      return { state: "destroyed", title: machine.title, lastError: machine.lastError };
    default:
      return machine;
  }
};

export const isWarmBrowserSession = (state: BrowserSessionState): boolean =>
  state === "loading" || state === "ready" || state === "failed" || state === "detached";

export type BrowserDeleteAction = "detach" | "kill-session" | "noop";

/**
 * Decision matrix for page-node delete / explicit kill.
 * Default onDelete is detach — never wipe profile; never force-kill without policy.
 */
export const browserDeleteAction = (input: {
  readonly onDelete?: "detach" | "kill-session";
  readonly sessionLive?: boolean;
  readonly explicitKill?: boolean;
}): BrowserDeleteAction => {
  if (input.explicitKill) {
    return input.sessionLive ? "kill-session" : "noop";
  }
  const policy = input.onDelete ?? "detach";
  if (policy === "kill-session") {
    return input.sessionLive ? "kill-session" : "detach";
  }
  return "detach";
};

// --- warm session pool (pure) ------------------------------------------------
// The main-process session service keeps at most maxWarmSessions live
// WebContentsViews. Eviction is decided here, Electron-free, so vitest covers
// the policy: evict the least-recently-active DETACHED session first; an
// attached (visible) session is never evicted; nothing is evicted while the
// pool fits. Destroying an evicted view only drops runtime state — the
// persist: partition on disk (cookies) always survives.

export interface WarmPoolEntry {
  readonly key: string;
  readonly attached: boolean;
  readonly lastActiveAt: number;
}

/**
 * Keys to destroy so that adding one more session keeps the pool within
 * maxWarmSessions. Returns [] when the incoming session already exists
 * (reuse, not growth) or the pool still fits.
 */
export const warmPoolEvictions = (
  pool: ReadonlyArray<WarmPoolEntry>,
  incomingKey: string,
  maxWarmSessions: number,
): ReadonlyArray<string> => {
  if (pool.some((e) => e.key === incomingKey)) return [];
  const boundedMaximum = Math.min(
    BROWSER_MAX_WARM_SESSIONS_HARD,
    Number.isFinite(maxWarmSessions) ? Math.max(1, Math.floor(maxWarmSessions)) : 1,
  );
  const overBy = pool.length + 1 - boundedMaximum;
  if (overBy <= 0) return [];
  return pool
    .filter((e) => !e.attached)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    .slice(0, overBy)
    .map((e) => e.key);
};

/** Electron partition name for a validated profile id. */
export const partitionNameForProfile = (profileId: string): string =>
  `persist:vellum-profile-${profileId}`;

/**
 * v1 scheme allowlist: http(s) only.
 * Rejects file:, javascript:, data:, and unparseable strings.
 */
export const isAllowedBrowserUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};
