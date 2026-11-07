import { homedir } from "node:os";
import { isAbsolute, dirname, join } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import type {
  HostDirectoryEntry,
  HostDirectorySnapshot,
} from "@shared/host-directory";

const MAX_DIRECTORY_ENTRIES = 400;

const expandHome = (input: string | undefined): string => {
  const requested = input?.trim();
  if (!requested || requested === "~") return homedir();
  if (requested.startsWith("~/")) return join(homedir(), requested.slice(2));
  return requested;
};

/**
 * Read-only host filesystem browser primitive. It never creates, removes, or
 * follows a caller-selected executable. Paths resolve on the station that
 * owns this function, which keeps host-local path meaning intact.
 */
export const readHostDirectory = async (
  requestedPath?: string,
): Promise<HostDirectorySnapshot> => {
  const expanded = expandHome(requestedPath);
  if (!isAbsolute(expanded)) {
    throw new Error("directory path must be absolute or start with ~");
  }
  const root = await realpath(expanded);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error("directory path does not name a directory");
  }

  const names = await readdir(root);
  const entries = await Promise.all(
    names.slice(0, MAX_DIRECTORY_ENTRIES).map(
      async (name): Promise<HostDirectoryEntry | undefined> => {
        const path = join(root, name);
        try {
          const info = await stat(path);
          return {
            name,
            path,
            kind: info.isDirectory() ? "directory" : "file",
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          };
        } catch {
          return undefined;
        }
      },
    ),
  );
  const parent = dirname(root);
  return {
    root,
    ...(parent !== root ? { parent } : {}),
    entries: entries
      .filter((entry): entry is HostDirectoryEntry => entry !== undefined)
      .sort((left, right) =>
        left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === "directory"
            ? -1
            : 1
      ),
  };
};
