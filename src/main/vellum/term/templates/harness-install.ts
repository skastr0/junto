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
} from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/features";

export type HarnessInstallProbe = {
  readonly harness: HarnessId;
  readonly displayName: string;
  readonly binary: string;
  /** True when an executable for the harness binary resolves. */
  readonly installed: boolean;
};

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Candidate absolute paths beyond PATH for known install layouts.
 * Keep short and honest — do not invent vendor trees we have not verified.
 */
const extraInstallCandidates = (
  harness: HarnessId,
  binary: string,
  home: string,
): readonly string[] => {
  switch (harness) {
    case "kimi":
      return [join(home, ".kimi-code", "bin", binary)];
    case "muse":
      // Sweep: muse may land on PATH after install; no extra tree required.
      return [];
    case "prime-agent":
      return [];
    case "claude":
      return [join(home, ".local", "bin", binary)];
    case "codex":
      return [join(home, ".local", "bin", binary)];
    case "grok":
      return [join(home, ".local", "bin", binary)];
    case "pi":
      return [join(home, ".local", "bin", binary)];
    case "devin":
      return [join(home, ".local", "bin", binary)];
    case "cursor":
      return [join(home, ".local", "bin", binary)];
    case "hermes":
      return [join(home, ".local", "bin", binary)];
    default:
      return [];
  }
};

/**
 * Resolve whether `binary` is an executable on PATH (or a known install home).
 * Absolute binary paths are checked as-is.
 */
export const harnessBinaryInstalled = (
  harness: HarnessId,
  binary: string,
  options?: {
    readonly pathEnv?: string;
    readonly home?: string;
    readonly pathSep?: string;
  },
): boolean => {
  const name = binary.trim();
  if (!name) return false;

  if (isAbsolute(name)) {
    return isExecutableFile(name);
  }

  const pathEnv = options?.pathEnv ?? process.env.PATH ?? process.env.Path ?? "";
  const sep = options?.pathSep ?? delimiter;
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    if (isExecutableFile(join(dir, name))) return true;
  }

  const home = options?.home ?? homedir();
  for (const candidate of extraInstallCandidates(harness, name, home)) {
    if (isExecutableFile(candidate)) return true;
  }
  return false;
};

const probeOne = (template: ManagedTerminalTemplate): HarnessInstallProbe => {
  const binary = template.argvSpec.binary;
  return {
    harness: template.harness,
    displayName: template.displayName,
    binary,
    installed: harnessBinaryInstalled(template.harness, binary),
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
