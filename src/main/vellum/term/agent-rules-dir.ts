/**
 * App-owned ephemeral rules directory for harnesses that load doctrine from a
 * file rather than a flag (Antigravity `--add-dir`).
 *
 * Provenance is the whole point of the shape: Vellum Command writes ONLY under
 * its own home (`<VELLUM_COMMAND_HOME>/.vellum-command/content/agent-rules/<seat>/`)
 * and mounts that directory into the seat's workspace. The operator's project
 * is never written to, no foreign `AGENTS.md` is indexed, and the doctrine the
 * seat reads cites an app-owned path as its origin.
 *
 * The directory is scratch, not content-addressed store: it is rewritten on
 * every spawn from the compiled doctrine, which stays the single source of
 * truth in `managed-terminal-injection`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveVellumCommandHome } from "@shared/vellum-home";

/** Doctrine filename read by the harness inside an added directory. */
export const AGENT_RULES_FILENAME = "AGENTS.md" as const;

/** Root of the per-seat ephemeral rules tree. */
export const agentRulesRoot = (
  home: string = resolveVellumCommandHome(),
): string => join(home, ".vellum-command", "content", "agent-rules");

/**
 * Path-safe directory key for one seat. Node ids are ULID-shaped
 * (`agent-01M0…`), but this never trusts that: anything outside the allowed
 * set is replaced so a crafted seat ref cannot escape the rules root.
 */
export const agentRulesDirKey = (seatRef: string): string | undefined => {
  const sanitized = seatRef.trim().replace(/[^A-Za-z0-9_-]/g, "-");
  if (sanitized.length === 0 || sanitized.length > 128) return undefined;
  return sanitized;
};

/** Directory Vellum Command mounts for this seat (no filesystem access). */
export const agentRulesDirFor = (
  seatRef: string,
  home: string = resolveVellumCommandHome(),
): string | undefined => {
  const key = agentRulesDirKey(seatRef);
  return key ? join(agentRulesRoot(home), key) : undefined;
};

/**
 * Write the compiled doctrine as the seat's `AGENTS.md` and return the
 * directory to mount. Returns undefined when the seat ref is unusable or the
 * write fails — the caller then falls back to typed delivery rather than
 * launching a seat that was told nothing.
 */
export const writeAgentRulesDir = (input: {
  readonly seatRef: string;
  readonly doctrine: string;
  readonly home?: string;
}): string | undefined => {
  const dir = agentRulesDirFor(
    input.seatRef,
    input.home ?? resolveVellumCommandHome(),
  );
  if (!dir) return undefined;
  const body = input.doctrine.trim();
  if (body.length === 0) return undefined;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, AGENT_RULES_FILENAME), `${body}\n`, "utf8");
    return dir;
  } catch {
    return undefined;
  }
};
