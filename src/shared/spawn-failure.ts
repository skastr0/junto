/**
 * Pre-ownership spawn failure classification for managed terminals.
 *
 * Product rule: a missing harness CLI is not "stopped". The canvas must say
 * which harness is missing and that it is not installed on this machine.
 * True post-run exits stay exited/stopped — this module only classifies
 * fail-before-ownership errors.
 */

import {
  isHarnessId,
  templateFor,
  type HarnessId,
} from "./managed-terminal-templates";

/** Why a terminal generation failed before a healthy run. */
export type SpawnExitReason = "cli-missing" | "spawn_failed";

export type ClassifiedSpawnFailure = {
  readonly reason: SpawnExitReason;
  /** Operator-facing label (activity mark title / card subtitle). */
  readonly message: string;
  /** Journal line body (no leading [junto] prefix). */
  readonly journal: string;
};

const MISSING_CLI_RE = /ENOENT|not found|command not found|posix_spawnp failed/i;

/** True when an error (or its cause chain) indicates a missing executable. */
export const isMissingExecutableError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      const code = (current as { readonly code?: unknown }).code;
      if (code === "ENOENT") return true;
      const message = (current as { readonly message?: unknown }).message;
      if (typeof message === "string" && MISSING_CLI_RE.test(message)) {
        return true;
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    if (typeof current === "string" && MISSING_CLI_RE.test(current)) {
      return true;
    }
    return false;
  }
  return false;
};

/** Display name for a harness id, or a title-cased fallback. */
export const harnessDisplayName = (
  harness: HarnessId | string | undefined,
): string | undefined => {
  if (!harness) return undefined;
  if (isHarnessId(harness)) return templateFor(harness).displayName;
  return harness;
};

/**
 * Operator copy: "{displayName} is not installed on this machine".
 * Prefer template displayName (Claude Code, Codex, …) over the raw binary.
 */
export const harnessNotInstalledMessage = (displayName: string): string =>
  `${displayName} is not installed on this machine`;

/**
 * Classify a pre-ownership spawn error into a product reason + copy.
 *
 * @param error - thrown spawn/unresolvable error
 * @param harness - seat harness when this is an agent generation
 */
export const classifySpawnFailure = (
  error: unknown,
  harness?: HarnessId | string,
): ClassifiedSpawnFailure => {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  const display = harnessDisplayName(harness);
  const missing = isMissingExecutableError(error);

  if (missing && display) {
    const message = harnessNotInstalledMessage(display);
    return {
      reason: "cli-missing",
      message,
      journal: `${message}. Install the ${display} CLI and ensure it is on PATH.`,
    };
  }
  if (missing) {
    const message = "CLI is not installed on this machine";
    return {
      reason: "cli-missing",
      message,
      journal: `${message}. Install the binary and ensure it is on PATH. (${raw})`,
    };
  }

  // Unresolvable launch / bad cwd / other pre-ownership failures.
  const message = display
    ? `${display} failed to start`
    : "failed to start";
  return {
    reason: "spawn_failed",
    message,
    journal: `${message}: ${raw}`,
  };
};
