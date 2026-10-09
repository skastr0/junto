import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { MachineBundleManifest, type MachineBundleFile } from "@shared/machine-install";

export const machineBundleFiles = async (root: string): Promise<MachineBundleFile[]> => {
  const files: MachineBundleFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (file === "manifest.json") continue;
      const absolute = join(root, file);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await walk(file);
      else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        files.push({path:file, bytes:metadata.size, mode:metadata.mode & 0o777, sha256:hash.digest("hex")});
      } else throw new Error(`bundle contains a link or special file: ${file}`);
    }
  };
  await walk("");
  return files.sort((left,right)=>left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
};

export const inspectMachineBundle = async (root: string): Promise<MachineBundleManifest> => {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("bundle must be a directory, not a link");
  const metadata = await lstat(join(root,"manifest.json"));
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("bundle manifest must be a regular file");
  const manifest = Schema.decodeUnknownSync(MachineBundleManifest,{onExcessProperty:"error"})(JSON.parse(await readFile(join(root,"manifest.json"),"utf8")));
  const files = await machineBundleFiles(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error("bundle files do not match the manifest");
  for (const required of ["bin/node", "bin/junto", "core/junto.cjs"]) {
    const file = files.find(file=>file.path===required);
    if (!file || (required.startsWith("bin/") && !(file.mode & 0o111))) throw new Error(`bundle is missing an executable or entry: ${required}`);
  }
  return manifest;
};
