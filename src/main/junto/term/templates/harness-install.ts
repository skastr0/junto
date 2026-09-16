/**
 * Local harness CLI install probe for the agent palette.
 *
 * Fail-soft and pure: never throws, never mutates PATH. A missing binary
 * means the harness is hidden from authoring — spawn would only show
 * "not installed" after a broken process start.
 */

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  allTemplates,
  templateFor,
  type HarnessId,
  type ManagedTerminalTemplate,
  type MailTransportSpec,
  type IsolationSpec,
} from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/features";
import { configuredToolDirectories } from "../../adapters/exec";
import { juntoCliPathPrefixes } from "./seat-env";

export type HarnessInstallProbe = {
  readonly harness: HarnessId;
  readonly displayName: string;
  readonly binary: string;
  /** True when an executable for the harness binary resolves. */
  readonly installed: boolean;
  readonly mailTransport: MailTransportSpec;
  readonly isolation: IsolationSpec;
};

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export type HarnessExecutableResolution = {
  readonly pathEnv?: string;
  readonly home?: string;
  readonly pathSep?: string;
  readonly extraDirs?: ReadonlyArray<string>;
};

/**
 * Home-relative install dirs detection and launch both search, including
 * `~/.kimi-code/bin`. System dirs such as `/usr/bin` come from PATH itself.
 */
export const knownHarnessInstallDirs = (home: string): ReadonlyArray<string> => [
  join(home, ".local", "bin"),
  join(home, ".kimi-code", "bin"),
  join(home, ".bun", "bin"),
  join(home, ".local", "share", "mise", "shims"),
];

/**
 * Directories detection and launch both search: the resolved seat PATH
 * (login-shell PATH merged upstream by resolvedSpawnEnv), operator tool
 * directories, then known home install dirs. No login shell is run here.
 */
export const harnessSearchPath = (
  options: HarnessExecutableResolution = {},
): string => {
  const home = options.home ?? homedir();
  const sep = options.pathSep ?? delimiter;
  const segments: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    for (const part of value.split(sep)) {
      const dir = part.trim();
      if (dir) segments.push(dir);
    }
  };
  push(options.pathEnv ?? process.env.PATH ?? process.env.Path ?? "");
  for (const dir of options.extraDirs ?? configuredToolDirectories()) {
    const trimmed = dir.trim();
    if (trimmed) segments.push(trimmed);
  }
  for (const dir of knownHarnessInstallDirs(home)) segments.push(dir);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of segments) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(sep);
};

/**
 * Resolve `binary` to an absolute executable using the same search path
 * detection and launch share. Absolute paths are checked as-is.
 */
export const resolveHarnessExecutable = (
  binary: string,
  options: HarnessExecutableResolution = {},
): string | undefined => {
  const name = binary.trim();
  if (!name) return undefined;
  if (isAbsolute(name)) return isExecutableFile(name) ? name : undefined;

  const sep = options.pathSep ?? delimiter;
  for (const dir of harnessSearchPath(options).split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
};

/**
 * Resolve whether `binary` is an executable on the shared search path.
 */
export const harnessBinaryInstalled = (
  harness: HarnessId,
  binary: string,
  options?: HarnessExecutableResolution,
): boolean => resolveHarnessExecutable(binary, harness === "junto-overseer" ? {
  ...options, extraDirs: [...juntoCliPathPrefixes(), ...(options?.extraDirs ?? configuredToolDirectories())],
} : options) !== undefined;

const probeOne = (template: ManagedTerminalTemplate): HarnessInstallProbe => {
  const binary = template.argvSpec.binary;
  return {
    harness: template.harness,
    displayName: template.displayName,
    binary,
    installed: harnessBinaryInstalled(template.harness, binary),
    mailTransport: template.mailTransport,
    isolation: template.isolation,
  };
};

/**
 * Feature-enabled harnesses only, with install status.
 * Palette should list `installed === true` rows.
 */
export const probeManagedHarnessInstalls = (): readonly HarnessInstallProbe[] =>
  allTemplates().map(probeOne);

/** Single harness probe (enabled + installed). Disabled harness → not installed. */
export const isManagedHarnessInstalled = (harness: HarnessId): boolean => {
  if (!managedHarnessEnabled(harness)) return false;
  const template = templateFor(harness);
  return harnessBinaryInstalled(harness, template.argvSpec.binary);
};
