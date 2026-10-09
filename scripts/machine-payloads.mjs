import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";

// Immutable packages sent to another machine. Signing must not change their
// inventoried bytes; the enclosing app resource seal authenticates the payload.
export const MACHINE_PAYLOAD_MACHO_PATHS = [
  "Contents/Resources/machines/darwin-arm64/bin/junto",
  "Contents/Resources/machines/darwin-arm64/bin/node",
  "Contents/Resources/machines/darwin-arm64/core/node_modules/node-pty/build/Release/pty.node",
  "Contents/Resources/machines/darwin-arm64/core/node_modules/node-pty/build/Release/spawn-helper",
];

export const isMachinePayloadPath = (appPath, filePath) => {
  const relative = path.relative(path.resolve(appPath), path.resolve(filePath)).split(path.sep).join("/");
  return ["darwin-arm64", "linux-x64"].some(target => {
    const root = `Contents/Resources/machines/${target}`;
    return relative === root || relative.startsWith(root + "/");
  });
};

export const snapshotMachinePayloads = async (appPath) => {
  const directory = path.join(appPath, "Contents/Resources/machines");
  const files = [];
  const walk = async (relative) => {
    const absolute = path.join(directory, relative);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const name of (await readdir(absolute)).sort()) await walk(relative ? `${relative}/${name}` : name);
    } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
      files.push({ path: relative, mode: metadata.mode & 0o777, sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
    } else throw new Error("machine payload snapshot refuses links and special files");
  };
  try { await walk(""); } catch (error) { if (error.code !== "ENOENT" || files.length) throw error; }
  return files;
};

export const assertMachinePayloadsUnchanged = (before, after) => {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const old = new Map(before.map(file => [file.path, file]));
    const changed = after.filter(file => JSON.stringify(file) !== JSON.stringify(old.get(file.path))).map(file => file.path);
    const removed = before.filter(file => !after.some(next => next.path === file.path)).map(file => file.path);
    throw new Error(`app signing changed sealed machine payloads: ${[...changed, ...removed].join(", ")}`);
  }
};
