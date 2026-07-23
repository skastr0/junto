import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type TerminalLaunchFailureCode =
  | "shell_missing"
  | "shell_not_executable"
  | "shell_not_absolute";

/** Typed before-spawn launch rejection; it never exposes process authority. */
export class TerminalLaunchError extends Error {
  constructor(
    readonly code: TerminalLaunchFailureCode,
    readonly shell: string,
  ) {
    super(`terminal shell ${code.replaceAll("_", " ")}: ${shell}`);
    this.name = "TerminalLaunchError";
  }
}

export interface ShellFilesystem {
  readonly stat: (path: string) => { readonly isFile: () => boolean };
  readonly accessExecutable: (path: string) => void;
}

const systemShellFilesystem: ShellFilesystem = {
  stat: (path) => statSync(path),
  // Permission bits are not an executability decision: access(2) also honors
  // the effective identity and platform ACLs. Always validate X_OK after the
  // regular-file check.
  accessExecutable: (path) => accessSync(path, constants.X_OK),
};

export const validateExecutableShell = (
  shell: string,
  filesystem: ShellFilesystem = systemShellFilesystem,
): string => {
  if (!isAbsolute(shell)) {
    throw new TerminalLaunchError("shell_not_absolute", shell);
  }

  let regularFile = false;
  try {
    regularFile = filesystem.stat(shell).isFile();
  } catch {
    throw new TerminalLaunchError("shell_missing", shell);
  }
  if (!regularFile) {
    throw new TerminalLaunchError("shell_missing", shell);
  }

  try {
    filesystem.accessExecutable(shell);
  } catch {
    throw new TerminalLaunchError("shell_not_executable", shell);
  }
  return shell;
};
