/**
 * Ephemeral, best-effort session-id observation for managed seats.
 *
 * This process-local map is diagnostic plumbing, not a cold-resume contract:
 * PTY output is untrusted, values are not persisted, and no spawn path consumes
 * them. Pin-capable harnesses store their authorial id on the canvas instead.
 */

const byBinding = new Map<string, string>();

export const recordCapturedSessionId = (
  bindingId: string,
  sessionId: string,
): void => {
  const id = bindingId.trim();
  const sid = sessionId.trim();
  if (!id || !sid) return;
  byBinding.set(id, sid);
};

export const getCapturedSessionId = (bindingId: string): string | undefined =>
  byBinding.get(bindingId.trim());

export const clearCapturedSessionId = (bindingId: string): void => {
  byBinding.delete(bindingId.trim());
};

export const resetSessionIdStoreForTest = (): void => {
  byBinding.clear();
};

// Every pattern below is compiled once at module load instead of per call.
// This runs on every PTY output chunk for the life of a session until an id
// is captured, so a `new RegExp` per label per chunk is pure waste — the
// source strings are static (label names are literal, never interpolated
// from untrusted input), so hoisting changes nothing about what matches.

const labelPattern = (name: string): RegExp =>
  new RegExp(
    String.raw`(?:["']${name}["']|\b${name}\b)\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_-]{7,})\b`,
    "i",
  );

// Priority-ordered: extractSessionIdFromText checks these in array order and
// returns the first match, exactly mirroring the original grouped-loop order.
const LABELED_ID_PATTERNS: readonly RegExp[] = [
  // SessionStart hook payloads carry these canonical fields. Prefer them over
  // terminal presentation because they identify the root harness session.
  labelPattern("session_id"),
  labelPattern("sessionId"),
  // Both are injected by their harness into agent command environments.
  labelPattern("CODEX_THREAD_ID"),
  labelPattern("HERMES_SESSION_ID"),
  // Codex notify payloads are available only after a completed turn.
  labelPattern("thread-id"),
  labelPattern("thread_id"),
];

// TUI status / exit receipts label their identifier but are less structured.
const DISPLAY_ID_PATTERN =
  /\b(?:session(?:\s+id)?|thread)(?:\s*[:=]\s*|\s+)([A-Za-z0-9][A-Za-z0-9_-]{7,})\b/i;

// Cheap pre-filter. Every pattern above, and the display fallback, requires
// the literal substring "session" or "thread" (case-insensitively) somewhere
// in the text — it is embedded in every label name and in the fallback's own
// alternation. A chunk containing neither can never match any pattern above,
// so a single non-backtracking alternation test short-circuits the whole
// scan for the common case (e.g. a TUI repaint chunk with no label at all).
// This is a necessary-not-sufficient gate: passing it does not imply a match
// (word-boundary rejections, short ids, etc. still apply downstream) — it
// only guarantees that failing it means no pattern below could possibly
// match, so skipping them is safe.
const MAY_CONTAIN_LABELED_ID = /session|thread/i;

/**
 * Best-effort extract session ids from PTY output / env-shaped text.
 *
 * The terminal is not a session-id channel: arbitrary command output commonly
 * contains UUIDs. Only accept IDs attached to a harness-specific environment
 * name or a verified session field/label.
 */
export const extractSessionIdFromText = (text: string): string | undefined => {
  if (!MAY_CONTAIN_LABELED_ID.test(text)) return undefined;

  for (const pattern of LABELED_ID_PATTERNS) {
    const id = pattern.exec(text)?.[1];
    if (id) return id;
  }

  return DISPLAY_ID_PATTERN.exec(text)?.[1];
};
