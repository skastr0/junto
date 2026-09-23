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

/**
 * Plain operator copy for the launches Junto refuses before spawning. Each
 * one completes the sentence "{Harness} could not start: …".
 */
export const launchRefusalCopy = {
  noFolder: "no folder is chosen for this seat",
  homeFolder: "its folder is your home folder, choose a project folder instead",
  folderMissing: (path: string): string => `the folder ${path} does not exist`,
  notAFolder: (path: string): string => `${path} is not a folder`,
  launchIncomplete: "its launch settings are incomplete",
} as const;

/**
 * A launch Junto refused before spawning anything. `operatorReason` is the
 * plain copy the seat card shows; the message keeps the technical detail for
 * the journal.
 */
export class LaunchRefusedError extends Error {
  readonly operatorReason: string;
  /** The harness binary itself is absent: classifies as cli-missing. */
  readonly missingExecutable: boolean;

  constructor(input: {
    readonly operatorReason: string;
    readonly detail: string;
    readonly missingExecutable?: boolean;
  }) {
    super(input.detail);
    this.name = "LaunchRefusedError";
    this.operatorReason = input.operatorReason;
    this.missingExecutable = input.missingExecutable === true;
  }
}

/** Longest raw error line a seat card shows when Junto has no plain copy for it. */
const RAW_REASON_MAX = 160;

/** First line of a raw error, bounded for a card subtitle. */
const rawReasonLine = (raw: string): string => {
  const line = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > RAW_REASON_MAX ? `${line.slice(0, RAW_REASON_MAX - 1)}…` : line;
};

/** True when an error (or its cause chain) indicates a missing executable. */
export const isMissingExecutableError = (error: unknown): boolean => {
  if (error instanceof LaunchRefusedError) return error.missingExecutable;
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

  // Refused launch / bad folder / other pre-ownership failures. The card
  // names the real reason: a bare "failed to start" left the operator nothing
  // to act on while the cause sat in an unrendered journal line.
  const subject = display ?? "The seat";
  const reasonCopy =
    error instanceof LaunchRefusedError ? error.operatorReason : rawReasonLine(raw);
  const message = reasonCopy
    ? `${subject} could not start: ${reasonCopy}`
    : `${subject} could not start`;
  return {
    reason: "spawn_failed",
    message,
    journal: raw && raw !== reasonCopy ? `${message}. (${raw})` : message,
  };
};
