import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxRuntimeArtifactName } from "./finalize-linux-package";

export const LINUX_RUNTIME_REQUIRED_FILES = [
  "vellum", "resources/app.asar", "resources/bin/vellum", "resources/bin/vellum-browser",
  "resources/bin/vellum-station", "resources/bin/unix-peer-pid.py",
  "resources/systemd/vellum-remote-launch", "resources/systemd/vellum-remote.service.template",
] as const;
const FORBIDDEN_SEGMENTS = new Set(["chrome-sandbox", "apparmor-profile", "vellum-release-installer", "vellum-release-bridge", "sudoers", "before-install.sh", "after-install.sh", "before-remove.sh", "after-remove.sh"]);

export const validateElfX64 = (header: Uint8Array, label: string): void => {
  if (header.length < 20 || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46 || header[4] !== 2 || header[5] !== 1 || header[18] !== 0x3e || header[19] !== 0) throw new Error(`${label} is not little-endian x86-64 ELF`);
};

const walk = async (root: string, relative = ""): Promise<string[]> => {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    const metadata = await lstat(path.join(root, child));
    if (metadata.isSymbolicLink()) throw new Error(`runtime contains symlink: ${child}`);
    if (entry.isDirectory()) result.push(...await walk(root, child));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`runtime contains unsupported entry: ${child}`);
  }
  return result;
};

export const validateUserServiceTemplate = (input: string): void => {
  if (!input.includes("ExecStart=@VELLUM_RUNTIME_ROOT@/resources/systemd/vellum-remote-launch\n")) throw new Error("user service must retain the runtime-root placeholder");
  if (/^\s*(?:User|Group|CapabilityBoundingSet|AmbientCapabilities|NoNewPrivileges)=/mu.test(input)) throw new Error("user service contains privileged directives");
};

const requireLoadable = (file: string): void => {
  const result = spawnSync("/usr/bin/ldd", [file], { encoding: "utf8", shell: false });
  if (result.status !== 0 || /not found/u.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`native runtime dependency is unavailable: ${file}`);
};

export const auditLinuxRuntime = async ({ runtimePath, version }: { readonly runtimePath: string; readonly version: string }): Promise<{ readonly ok: true; readonly artifact: string; readonly nativeObjects: ReadonlyArray<string>; readonly chromeSandbox: "absent" }> => {
  const root = path.resolve(runtimePath);
  if (path.basename(root) !== linuxRuntimeArtifactName({ version, arch: "x64" })) throw new Error("runtime artifact name mismatch");
  const files = await walk(root);
  for (const required of LINUX_RUNTIME_REQUIRED_FILES) if (!files.includes(required)) throw new Error(`runtime required file missing: ${required}`);
  for (const file of files) if (file.split("/").some((part) => FORBIDDEN_SEGMENTS.has(part)) || /(?:^|\/)(?:opt|usr|etc|var)(?:\/|$)/u.test(file)) throw new Error(`privileged packaging residue: ${file}`);
  const nativeObjects: string[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const metadata = await lstat(absolute);
    if ((metadata.mode & 0o7000) !== 0) throw new Error(`runtime has privileged mode bits: ${file}`);
    const header = await readFile(absolute).then((contents) => contents.subarray(0, 20));
    if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
      validateElfX64(header, file); nativeObjects.push(file); requireLoadable(absolute);
    }
  }
  validateUserServiceTemplate(await readFile(path.join(root, "resources/systemd/vellum-remote.service.template"), "utf8"));
  return { ok: true, artifact: path.basename(root), nativeObjects, chromeSandbox: "absent" };
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [flag, runtimePath] = process.argv.slice(2);
  if (flag !== "--runtime" || runtimePath === undefined || process.argv.length !== 4) throw new Error("usage: audit-linux-package.ts --runtime <directory>");
  const version = path.basename(runtimePath).match(/^vellum-runtime-(.+)-linux-x64$/u)?.[1];
  if (version === undefined) throw new Error("runtime artifact name mismatch");
  process.stdout.write(`${JSON.stringify(await auditLinuxRuntime({ runtimePath, version }))}\n`);
}
