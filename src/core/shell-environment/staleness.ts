import { stat } from "node:fs/promises";
import { basename, join } from "node:path";

const ZSH_STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;
const BASH_STARTUP_FILES = [".bash_profile", ".bashrc", ".profile"] as const;

/**
 * The startup files a login, interactive shell reads itself: zsh's under
 * $ZDOTDIR or the home, bash's in the home. Other shells: none; refresh()
 * covers them.
 */
export const shellStartupFiles = (
  shell: string,
  where: { readonly home: string; readonly zdotdirs?: ReadonlyArray<string | undefined> },
): ReadonlyArray<string> => {
  const name = basename(shell);
  if (name === "zsh") {
    // .zshenv is read before ZDOTDIR can move, so the home's always counts.
    const dirs = [...new Set([where.home, ...(where.zdotdirs ?? []).filter((dir): dir is string => Boolean(dir))])];
    return dirs.flatMap((dir) => ZSH_STARTUP_FILES.map((file) => join(dir, file)));
  }
  if (name === "bash") return BASH_STARTUP_FILES.map((file) => join(where.home, file));
  return [];
};

export const fileMtimeMs = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
};
