/**
 * Runtime session-id capture for managed seats (Codex/Hermes).
 * Pin harnesses store id on the canvas at authoring; capture harnesses
 * record here when the id is observed, and mutate the canvas when possible.
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

/**
 * Best-effort extract session ids from PTY output / env-shaped text.
 *
 * The terminal is not a session-id channel: arbitrary command output commonly
 * contains UUIDs. Only accept IDs attached to a harness-specific environment
 * name or a verified session field/label.
 */
export const extractSessionIdFromText = (text: string): string | undefined => {
  const labeledId = (name: string): string | undefined => {
    const match = new RegExp(
      String.raw`(?:["']${name}["']|\b${name}\b)\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_-]{7,})\b`,
      "i",
    ).exec(text);
    return match?.[1];
  };

  // SessionStart hook payloads carry these canonical fields. Prefer them over
  // terminal presentation because they identify the root harness session.
  for (const name of ["session_id", "sessionId"]) {
    const id = labeledId(name);
    if (id) return id;
  }

  // Both are injected by their harness into agent command environments.
  for (const name of ["CODEX_THREAD_ID", "HERMES_SESSION_ID"]) {
    const id = labeledId(name);
    if (id) return id;
  }

  // Codex notify payloads are available only after a completed turn.
  for (const name of ["thread-id", "thread_id"]) {
    const id = labeledId(name);
    if (id) return id;
  }

  // TUI status / exit receipts label their identifier but are less structured.
  const display = /\b(?:session(?:\s+id)?|thread)(?:\s*[:=]\s*|\s+)([A-Za-z0-9][A-Za-z0-9_-]{7,})\b/i.exec(
    text,
  );
  return display?.[1];
};
