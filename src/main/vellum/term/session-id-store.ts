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
 * Patterns verified in managed-terminal probes (not exhaustive).
 */
export const extractSessionIdFromText = (text: string): string | undefined => {
  // UUID-shaped (Claude/Grok session ids, many harnesses)
  const uuid =
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(
      text,
    );
  if (uuid?.[1]) return uuid[1];
  // CODEX_THREAD_ID=...
  const codex = /\bCODEX_THREAD_ID[=:\s]+([A-Za-z0-9_-]{8,})\b/.exec(text);
  if (codex?.[1]) return codex[1];
  // HERMES_SESSION_ID=...
  const hermes = /\bHERMES_SESSION_ID[=:\s]+([A-Za-z0-9_-]{8,})\b/.exec(text);
  if (hermes?.[1]) return hermes[1];
  return undefined;
};
