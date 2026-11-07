/**
 * Kimi Code session scrape.
 *
 * On 0.34.0 the TUI starts without a session (changelog 0.33.0: "Start the
 * interactive TUI without creating a session."). A trusted-cwd welcome card
 * prints a blank `Session:` line plus "No session yet — one will be created
 * on your first message." That spawn card is not a receipt. `Session: <id>`
 * is a post-first-message scrape, if the card later fills — whether it does
 * is UNVERIFIED and is not a shipped claim.
 *
 * Durable proof is the harness store, already probed by `kimiSessionExists`:
 *
 *   ~/.kimi-code/sessions/<workDirKey>/<id>/
 *
 * Live ids are `ses_<uuid>` or `session_<uuid>`. Junto never
 * installs SessionStart hooks; a structured `session_id` is accepted only
 * when an operator already configured one and the token is a Kimi id.
 *
 * Read-only. Nothing here writes under ~/.kimi-code.
 */

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** `ses_<uuid>`, `session_<uuid>`, or a bare uuid. */
const KIMI_SESSION_ID = new RegExp(
  String.raw`^(?:ses_|session_)?(?:${UUID}|[0-9a-f]{8,})$`,
  "i",
);

const structuredId = (name: string): RegExp =>
  new RegExp(
    String.raw`(?:["']${name}["']|\b${name}\b)\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_-]{7,})\b`,
    "i",
  );

const SESSION_ID_FIELD = structuredId("session_id");
const SESSIONID_FIELD = structuredId("sessionId");

/** Welcome-card label only. Requires a token — a blank `Session:` never matches. */
const KIMI_CARD_SESSION =
  /\bSession:\s*([A-Za-z0-9][A-Za-z0-9_-]{7,})\b/i;

export const isKimiSessionId = (value: string): boolean =>
  KIMI_SESSION_ID.test(value.trim());

/**
 * Best-effort Kimi id from PTY text. The spawn-time welcome card is ignored.
 * A later filled `Session: <id>` is a scrape candidate; persist still has to
 * prove it against ~/.kimi-code/sessions/<workDirKey>/<id>/.
 */
export const extractKimiSessionIdFromText = (
  text: string,
): string | undefined => {
  const structured =
    SESSION_ID_FIELD.exec(text)?.[1] ?? SESSIONID_FIELD.exec(text)?.[1];
  if (structured && isKimiSessionId(structured)) return structured;

  const card = KIMI_CARD_SESSION.exec(text)?.[1];
  if (card && isKimiSessionId(card)) return card;
  return undefined;
};
