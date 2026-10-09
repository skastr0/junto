import { execFileSync } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacSigningConfig } from "./mac-signing-config.mjs";

const MAGIC = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const machineSigningIdentifier = (relative) => `junto.machine.${relative.replaceAll("/", "-").replaceAll(".", "-")}`;
export const machineNeedsJit = (relative) => relative === "bin/node" || relative === "bin/junto";

export const machineMachOFiles = async (directory) => {
  const files = [];
  const walk = async (relative) => {
    const absolute = path.join(directory, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error("machine signing refuses links");
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) await walk(relative ? `${relative}/${entry}` : entry);
    } else if (metadata.isFile() && metadata.nlink === 1 && metadata.uid === process.getuid?.()) {
      const handle = await open(absolute, "r");
      try {
        const bytes = Buffer.alloc(4);
        const { bytesRead } = await handle.read(bytes, 0, 4, 0);
        if (bytesRead === 4 && MAGIC.has(bytes.toString("hex"))) files.push(relative);
      } finally { await handle.close(); }
    } else throw new Error("machine signing requires owned regular staging files");
  };
  await walk("");
  return files;
};

/** Sign private native staging before its immutable manifest is generated. */
export const signMachineBundle = async (directory, target, environment = process.env, run = execFileSync) => {
  if (target !== "darwin-arm64") return;
  if (!environment.JUNTO_MAC_TEAM_ID && !environment.JUNTO_MAC_SIGNING_IDENTITY) return;
  const config = resolveMacSigningConfig(environment);
  for (const relative of await machineMachOFiles(directory)) {
    const jit = machineNeedsJit(relative);
    run("/usr/bin/codesign", ["--force", "--sign", config.signingIdentity, "--identifier", machineSigningIdentifier(relative), "--timestamp", "--options", "runtime", "--entitlements", path.join(root, "build", jit ? "entitlements.machine-runtime.plist" : "entitlements.mac.inherit.plist"), path.join(directory, relative)], { stdio: "inherit", timeout: 300_000 });
    run("/usr/bin/codesign", ["--verify", "--strict", path.join(directory, relative)], { stdio: "inherit", timeout: 300_000 });
  }
};
