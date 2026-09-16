/**
 * App-owned ephemeral agent definition for harnesses whose Tier-A carrier is a
 * FILE rather than a flag string (Kimi `--agent-file`).
 *
 * Kimi has no system-prompt flag: the way to brief a seat before its first turn
 * is a Markdown agent definition whose body becomes the system prompt. So the
 * compiled doctrine is written to a file Junto owns —
 * `<JUNTO_HOME>/.vellum-command/content/agent-files/<seat>.md` — and the
 * path is handed to the harness. The operator's project is never written to.
 *
 * The frontmatter is the verified schema and nothing else:
 *
 * - `name` (required, kebab-case) and `description` (required) — validation is
 *   strict and pre-flight, so a malformed key kills the seat before any model
 *   call rather than degrading quietly.
 * - `tools` is written as the single entry `"*"` (unrestricted). The quotes are
 *   load-bearing: a bare `*` is a YAML alias indicator, not a string.
 * - `allowed-tools` is NEVER emitted. It is a Claude-side key and Kimi warns it
 *   may misread it.
 *
 * Optional keys the schema allows (`whenToUse`, `override`, `disallowedTools`,
 * `subagents`, `model_preference`) are deliberately absent: a seat's doctrine is
 * the body, and every extra key is another way for a strict validator to refuse
 * to start.
 *
 * The file is scratch, rewritten on every spawn from the compiled doctrine,
 * which stays the single source of truth in `managed-terminal-injection`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveVellumCommandHome } from "@shared/vellum-home";

/** Frontmatter `name`. Kebab-case, stable, and never derived from a node id. */
export const AGENT_FILE_NAME = "vellum-command-seat" as const;

export const AGENT_FILE_DESCRIPTION =
  "Factory seat doctrine and CLI contract for this Junto seat." as const;

/** Root of the per-seat ephemeral agent-definition tree. */
export const agentFileRoot = (
  home: string = resolveVellumCommandHome(),
): string => join(home, ".vellum-command", "content", "agent-files");

/**
 * Path-safe key for one seat. Node ids are ULID-shaped (`agent-01M0…`), but
 * this never trusts that: anything outside the allowed set is replaced so a
 * crafted seat ref cannot escape the agent-file root.
 */
export const agentFileKey = (seatRef: string): string | undefined => {
  const sanitized = seatRef.trim().replace(/[^A-Za-z0-9_-]/g, "-");
  if (sanitized.length === 0 || sanitized.length > 128) return undefined;
  return sanitized;
};

/** File Junto hands to the harness (no filesystem access). */
export const agentFilePathFor = (
  seatRef: string,
  home: string = resolveVellumCommandHome(),
): string | undefined => {
  const key = agentFileKey(seatRef);
  return key ? join(agentFileRoot(home), `${key}.md`) : undefined;
};

/**
 * The exact bytes of the agent definition. Pure, so the frontmatter contract
 * is testable without touching a filesystem.
 */
export const buildAgentFileSpec = (doctrine: string): string | undefined => {
  const body = doctrine.trim();
  if (body.length === 0) return undefined;
  return [
    "---",
    `name: ${AGENT_FILE_NAME}`,
    `description: ${AGENT_FILE_DESCRIPTION}`,
    // Quoted: an unquoted * is a YAML alias indicator, not the wildcard.
    'tools: ["*"]',
    "---",
    "",
    body,
    "",
  ].join("\n");
};

/**
 * Write the compiled doctrine as the seat's agent definition and return the
 * path to pass to `--agent-file`. Returns undefined when the seat ref is
 * unusable, the doctrine is empty, or the write fails — the caller then falls
 * back to typed delivery rather than launching a seat that was told nothing.
 */
export const writeAgentFileSpec = (input: {
  readonly seatRef: string;
  readonly doctrine: string;
  readonly home?: string;
}): string | undefined => {
  const home = input.home ?? resolveVellumCommandHome();
  const path = agentFilePathFor(input.seatRef, home);
  if (!path) return undefined;
  const spec = buildAgentFileSpec(input.doctrine);
  if (!spec) return undefined;
  try {
    mkdirSync(agentFileRoot(home), { recursive: true });
    writeFileSync(path, spec, "utf8");
    return path;
  } catch {
    return undefined;
  }
};
