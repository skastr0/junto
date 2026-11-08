import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type { ShellEnvironmentFailure } from "@shared/shell-environment";
import { TOOL_MAX_OUTPUT_BYTES, type ToolResult, type ToolRunner } from "../region-env/tool";

// The probe is `$SHELL -l -i -c` printing a sentinel-framed `env -0`. It runs
// as an owned child on the process plane with stdin closed, a hard timeout
// and an output cap, from an app-owned directory (never the operator home),
// with JUNTO_RESOLVING_ENVIRONMENT=1 so an rc file can skip heavy work. Its
// rc files run under Junto's TCC identity exactly as a Junto terminal's
// `$SHELL -l` does; measured on 2026-10-19, they raised no TCC check at all
// (docs/macos-privacy.md).

export const SHELL_ENVIRONMENT_TIMEOUT_MS = 10_000;
export const SHELL_ENVIRONMENT_RESOLVING_KEY = "JUNTO_RESOLVING_ENVIRONMENT";
/** `inherit` skips the probe: hermetic test runs, or an rc that must not run. */
export const SHELL_ENVIRONMENT_SWITCH_KEY = "JUNTO_SHELL_ENVIRONMENT";

const SHELL_ENVIRONMENT_BEGIN = "JUNTO_ENV_BEGIN";
const SHELL_ENVIRONMENT_END = "JUNTO_ENV_END";

// Shell bookkeeping and the probe's own markers. The app's own namespaces stay
// as its launcher set them: an rc file that exports JUNTO_HOME must not move a
// running Junto onto another home.
const SHELL_SESSION_KEYS: ReadonlySet<string> = new Set([
  "_",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "TERM",
  SHELL_ENVIRONMENT_RESOLVING_KEY,
]);
const APP_OWNED_KEY = /^(?:JUNTO_|ELECTRON_)/u;

/**
 * The environment between the probe sentinels. rc output (motd, prompts,
 * hook noise) lands outside them and is discarded. Undefined when a sentinel
 * is missing (timeout, output cap, a shell that died) or `env -0` was not
 * understood, so nothing half-read is ever applied.
 */
export const shellEnvironmentFromProbeOutput = (
  output: string,
): Readonly<Record<string, string>> | undefined => {
  const marker = `${SHELL_ENVIRONMENT_BEGIN}\n`;
  const begin = output.indexOf(marker);
  if (begin < 0) return undefined;
  const bodyStart = begin + marker.length;
  const end = output.lastIndexOf(SHELL_ENVIRONMENT_END);
  if (end < bodyStart) return undefined;
  const body = output.slice(bodyStart, end);
  if (!body.endsWith("\0")) return undefined;
  const environment: Record<string, string> = {};
  for (const entry of body.slice(0, -1).split("\0")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const key = entry.slice(0, equals);
    if (SHELL_SESSION_KEYS.has(key) || APP_OWNED_KEY.test(key)) continue;
    environment[key] = entry.slice(equals + 1);
  }
  return environment.PATH ? environment : undefined;
};

/** The operator's login shell: `$SHELL`, else the account's, else the platform's. */
export const operatorShell = (
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (process.platform === "win32") return undefined;
  for (const candidate of [environment.SHELL, accountShell()]) {
    const shell = candidate?.trim();
    if (shell && isAbsolute(shell) && isExecutable(shell)) return shell;
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
};

const accountShell = (): string | undefined => {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export type ShellEnvironmentProbe = {
  readonly shell: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
};

export type ShellEnvironmentProbeResult =
  | { readonly ok: true; readonly environment: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly cause: ShellEnvironmentFailure };

/** Why a finished run gave no environment, from what the process plane saw. */
const causeOf = (result: ToolResult, timeoutMs: number): ShellEnvironmentFailure => {
  switch (result.kind) {
    case "timeout":
      return { _tag: "TimedOut", timeoutMs };
    case "not-installed":
      return { _tag: "SpawnFailed", errno: "ENOENT" };
    case "failed":
      if (result.why === "output-limit") return { _tag: "OutputTooLarge", maxBytes: TOOL_MAX_OUTPUT_BYTES };
      if (result.why === "signal") return { _tag: "Exited", ...(result.signal ? { signal: result.signal } : {}) };
      return { _tag: "SpawnFailed", ...(result.errno ? { errno: result.errno } : {}) };
    case "exit":
      return { _tag: "Exited", code: result.code };
    case "ok":
      return { _tag: "NoEnvironment" };
  }
};

/**
 * Run the operator's login+interactive shell once and read its environment.
 * `-l` sources login files (.zprofile, .profile), `-i` interactive rc
 * (.zshrc, .bashrc) where PATH exports and version-manager activation live.
 * Never throws. A failure carries a code, never the shell's own output: rc
 * stderr can echo a secret.
 */
export const probeShellEnvironment = async (
  runTool: ToolRunner,
  probe: ShellEnvironmentProbe,
): Promise<ShellEnvironmentProbeResult> => {
  const timeoutMs = probe.timeoutMs ?? SHELL_ENVIRONMENT_TIMEOUT_MS;
  const result = await runTool({
    source: "shell-environment.probe",
    purpose: "operator login-shell environment",
    command: probe.shell,
    args: [
      "-l",
      "-i",
      "-c",
      // The markers are split mid-token so the command line itself, echoed
      // by a tracing rc, never carries a whole sentinel.
      `echo JUNTO_ENV_""BEGIN; env -0; echo JUNTO_ENV_""END`,
    ],
    timeoutMs,
    cwd: probe.cwd,
    env: { ...probe.env, TERM: "dumb", [SHELL_ENVIRONMENT_RESOLVING_KEY]: "1" },
  });
  // A shell can exit non-zero after a complete dump (an rc's last command
  // failing); the sentinels, not the exit code, say whether it was read.
  const environment = result.kind === "ok" || result.kind === "exit"
    ? shellEnvironmentFromProbeOutput(result.stdout)
    : undefined;
  return environment ? { ok: true, environment } : { ok: false, cause: causeOf(result, timeoutMs) };
};
