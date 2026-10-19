import {
  decodeShellEnvironmentStatus,
  type ShellEnvironmentChange,
  type ShellEnvironmentFailure,
  type ShellEnvironmentStatus,
} from "@shared/shell-environment";
import type { ManagedTerminalHarnessesResult, ShellEnvironmentApi } from "@shared/ipc";

/**
 * The onboarding's shell step, worked out from what main reports: which
 * shell Junto read, how long it took, the PATH directories it added, and
 * which harnesses that PATH finds. Names, directories and typed causes only:
 * a shell environment carries keys and tokens, and nothing here ever holds a
 * variable's value.
 */

/** What an rc file checks to skip heavy work while Junto reads it. */
export const RESOLVING_ESCAPE = "JUNTO_RESOLVING_ENVIRONMENT";

export type ShellStepTone = "resolved" | "reading" | "failed" | "inherited";

export interface ShellStepView {
  readonly tone: ShellStepTone;
  readonly headline: string;
  /** Short facts under the headline ("zsh", "read in 420 ms"). */
  readonly facts: ReadonlyArray<string>;
  /** PATH directories the shell added beyond what Junto inherited. */
  readonly pathAdded: ReadonlyArray<string>;
  /** Why the read failed, in plain words; failed only. */
  readonly cause?: string;
  /** What seats use meanwhile; failed only. */
  readonly fallback?: string;
  /** Offer the JUNTO_RESOLVING_ENVIRONMENT escape for heavy rc work. */
  readonly escape: boolean;
}

/** /bin/zsh reads as zsh. */
export const shellName = (shell: string): string => shell.split("/").filter(Boolean).at(-1) ?? shell;

const seconds = (ms: number): string => {
  const value = ms / 1000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} s`;
};

const duration = (ms: number): string => (ms < 1000 ? `${ms} ms` : seconds(ms));

/** Each failure in the operator's words; the cause is typed, never free text. */
export const failureWords = (cause: ShellEnvironmentFailure): string => {
  switch (cause._tag) {
    case "NoShell":
      return "Junto found no shell to read.";
    case "SpawnFailed":
      return cause.errno ? `Your shell could not start (${cause.errno}).` : "Your shell could not start.";
    case "TimedOut":
      return `Your shell took longer than ${seconds(cause.timeoutMs)} to start. That is usually heavy work in an rc file.`;
    case "Exited": {
      const how =
        cause.code !== undefined ? ` with code ${cause.code}` : cause.signal !== undefined ? ` on ${cause.signal}` : "";
      return `Your shell exited${how} before it printed its environment. An rc file likely stopped on an error.`;
    }
    case "NoEnvironment":
      return "Your shell started, but Junto could not read the environment it printed.";
    case "OutputTooLarge":
      return `Your shell printed more than ${Math.round(cause.maxBytes / 1024)} KB as it started, more than Junto reads.`;
  }
};

export const shellStepView = (status: ShellEnvironmentStatus): ShellStepView => {
  switch (status._tag) {
    case "Resolving":
      return { tone: "reading", headline: "Reading your shell", facts: [], pathAdded: [], escape: false };
    case "Resolved":
      return {
        tone: "resolved",
        headline: `Junto read your ${shellName(status.shell)} environment`,
        facts: [
          shellName(status.shell),
          `read in ${duration(status.durationMs)}`,
          `${status.variableCount} ${status.variableCount === 1 ? "variable" : "variables"}`,
        ],
        pathAdded: status.pathAdded,
        escape: false,
      };
    case "Failed":
      return {
        tone: "failed",
        headline: status.shell ? `Junto could not read your ${shellName(status.shell)} environment` : "Junto could not read your shell",
        facts: status.shell ? [shellName(status.shell)] : [],
        pathAdded: [],
        cause: failureWords(status.cause),
        fallback: status.usingPrevious
          ? "Seats keep the environment Junto read before."
          : "Seats start with the PATH Junto itself was started with.",
        escape: status.cause._tag !== "NoShell" && status.cause._tag !== "SpawnFailed",
      };
    case "Inherited":
      return {
        tone: "inherited",
        headline: "Junto uses the environment it was started with",
        facts: ["set not to read your shell"],
        pathAdded: [],
        escape: false,
      };
  }
};

/** What a reload changed, counted: names are never listed, values never sent. */
export const changeSummary = (change: ShellEnvironmentChange | undefined): string => {
  if (!change) return "Nothing changed since the last read.";
  const variables = change.added.length + change.removed.length + change.changed.length;
  const parts = [
    variables > 0 ? `${variables} ${variables === 1 ? "variable" : "variables"} changed` : null,
    change.pathAdded.length > 0 ? `${change.pathAdded.length} PATH ${change.pathAdded.length === 1 ? "directory" : "directories"} added` : null,
    change.pathRemoved.length > 0
      ? `${change.pathRemoved.length} PATH ${change.pathRemoved.length === 1 ? "directory" : "directories"} removed`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Nothing changed since the last read." : `${parts.join(", ")}.`;
};

export interface ShellStepRead {
  readonly status: ShellEnvironmentStatus;
  /** Display names of the harnesses this PATH finds, and of those it does not. */
  readonly found: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
}

type ShellStepApi = {
  readonly shellEnvironment?: ShellEnvironmentApi;
  readonly managedTerminalHarnesses?: () => Promise<ManagedTerminalHarnessesResult>;
};

const harnessesOf = async (api: ShellStepApi): Promise<Pick<ShellStepRead, "found" | "missing">> => {
  const listed = await api.managedTerminalHarnesses?.().catch(() => undefined);
  const harnesses = listed?.harnesses ?? [];
  return {
    found: harnesses.filter((option) => option.installed).map((option) => option.displayName),
    missing: harnesses.filter((option) => !option.installed).map((option) => option.displayName),
  };
};

/**
 * Open the step: status() waits for the first read in main (ensure), so it
 * never answers unresolved, then the harnesses that PATH finds.
 */
export const readShellStep = async (api: ShellStepApi): Promise<ShellStepRead | undefined> => {
  if (!api.shellEnvironment) return undefined;
  const status = decodeShellEnvironmentStatus(await api.shellEnvironment.status());
  return { status, ...(await harnessesOf(api)) };
};

/**
 * Reload: re-read the shell, then ask again which harnesses are found, since
 * the environment module stays below harness detection.
 */
export const reloadShellStep = async (api: ShellStepApi): Promise<ShellStepRead | undefined> => {
  if (!api.shellEnvironment) return undefined;
  const status = decodeShellEnvironmentStatus(await api.shellEnvironment.refresh());
  return { status, ...(await harnessesOf(api)) };
};
