import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const executableFiles = new Set([
  "bin/node", "bin/junto", "core/node_modules/node-pty/build/Release/pty.node",
  "core/node_modules/node-pty/build/Release/spawn-helper",
]);

/** Seal newly built private staging files independently of the builder's umask. */
export const normalizeMachineBundleModes = async (root: string): Promise<void> => {
  const walk = async (relative: string): Promise<void> => {
    const absolute = join(root, relative), metadata = await lstat(absolute);
    if (metadata.uid !== process.getuid?.() || metadata.isSymbolicLink()) throw new Error("Machine staging contains a foreign file or link");
    if (metadata.isDirectory()) {
      await chmod(absolute, relative === "" ? 0o700 : 0o755);
      for (const entry of await readdir(absolute)) await walk(relative ? `${relative}/${entry}` : entry);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      await chmod(absolute, executableFiles.has(relative) ? 0o755 : 0o644);
    } else throw new Error("Machine staging contains a hard link or special file");
  };
  await walk("");
};
