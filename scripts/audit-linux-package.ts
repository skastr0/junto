import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxRuntimeArtifactName } from "./finalize-linux-package";
import {
  DEFAULT_NODE_REMOTE_MODULE_ABI,
  DEFAULT_NODE_REMOTE_VERSION,
} from "./build-linux-remote-runtime";

export const LINUX_RUNTIME_REQUIRED_FILES = [
  "vellum-command",
  "resources/app.asar",
  "resources/bin/vellum-command",
  "resources/bin/vellum-command-remote",
  "resources/bin/node",
  "resources/bin/unix-peer-pid.py",
  "resources/app-remote/vellum-command-remote.js",
  "resources/systemd/vellum-command-remote-launch",
  "resources/systemd/vellum-command-remote.service.template",
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
  if (!input.includes("ExecStart=@VELLUM_COMMAND_RUNTIME_ROOT@/resources/systemd/vellum-command-remote-launch\n")) throw new Error("user service must retain the runtime-root placeholder");
  if (/^\s*(?:User|Group|CapabilityBoundingSet|AmbientCapabilities|NoNewPrivileges)=/mu.test(input)) throw new Error("user service contains privileged directives");
};

const requireLoadable = (file: string): void => {
  const result = spawnSync("/usr/bin/ldd", [file], { encoding: "utf8", shell: false });
  if (result.status !== 0 || /not found/u.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`native runtime dependency is unavailable: ${file}`);
};

export const validateBundledNodeVersion = (output: string): string => {
  const actual = output.trim();
  const expected = `v${DEFAULT_NODE_REMOTE_VERSION}`;
  if (actual !== expected) {
    throw new Error(`bundled Node version mismatch: expected ${expected}, got ${actual || "empty"}`);
  }
  return DEFAULT_NODE_REMOTE_VERSION;
};

export type BundledNodeRuntimeIdentity = {
  readonly nodeVersion: string;
  readonly moduleAbi: string;
};

export const validateBundledNodeRuntimeIdentity = (
  output: string,
): BundledNodeRuntimeIdentity => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("bundled Node identity probe returned invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("node" in parsed) ||
    !("modules" in parsed) ||
    typeof parsed.node !== "string" ||
    typeof parsed.modules !== "string"
  ) {
    throw new Error("bundled Node identity probe returned the wrong shape");
  }
  const nodeVersion = validateBundledNodeVersion(`v${parsed.node}`);
  if (parsed.modules !== DEFAULT_NODE_REMOTE_MODULE_ABI) {
    throw new Error(
      `bundled Node module ABI mismatch: expected ${DEFAULT_NODE_REMOTE_MODULE_ABI}, got ${parsed.modules}`,
    );
  }
  return { nodeVersion, moduleAbi: parsed.modules };
};

const requireBundledNodeRuntimeIdentity = (
  file: string,
): BundledNodeRuntimeIdentity => {
  const result = spawnSync(
    file,
    [
      "-p",
      'JSON.stringify({node:process.versions.node,modules:process.versions.modules})',
    ],
    { encoding: "utf8", shell: false, timeout: 5_000 },
  );
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`bundled Node identity probe failed: ${file}`);
  }
  return validateBundledNodeRuntimeIdentity(result.stdout);
};

const requireRemoteNodePty = (input: {
  readonly node: string;
  readonly nodePtyRoot: string;
}): void => {
  const probe = `
const pty = require(process.argv[1]);
const child = pty.spawn("/bin/sh", ["-lc", "printf remote-node-pty-ok"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: "/tmp",
  env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
});
let output = "";
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 5000);
child.onData((chunk) => { output += chunk; });
child.onExit((event) => {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ output, exitCode: event.exitCode }));
  process.exitCode = event.exitCode === 0 && output.includes("remote-node-pty-ok") ? 0 : 1;
});
`;
  const result = spawnSync(input.node, ["-e", probe, input.nodePtyRoot], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  if (
    result.status !== 0 ||
    result.error !== undefined ||
    !result.stdout.includes("remote-node-pty-ok")
  ) {
    throw new Error(
      `bundled Node node-pty probe failed: ${`${result.stderr || result.stdout || result.error?.message || "no output"}`.trim().slice(0, 1_000)}`,
    );
  }
};

export const auditLinuxRuntime = async ({ runtimePath, version }: { readonly runtimePath: string; readonly version: string }): Promise<{ readonly ok: true; readonly artifact: string; readonly nativeObjects: ReadonlyArray<string>; readonly chromeSandbox: "absent"; readonly nodeVersion: string; readonly nodeModuleAbi: string; readonly remoteNodePty: "functional" }> => {
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
  validateUserServiceTemplate(await readFile(path.join(root, "resources/systemd/vellum-command-remote.service.template"), "utf8"));
  const node = path.join(root, "resources/bin/node");
  const nodeIdentity = requireBundledNodeRuntimeIdentity(node);
  requireRemoteNodePty({
    node,
    nodePtyRoot: path.join(root, "resources/app-remote/node_modules/node-pty"),
  });
  return {
    ok: true,
    artifact: path.basename(root),
    nativeObjects,
    chromeSandbox: "absent",
    nodeVersion: nodeIdentity.nodeVersion,
    nodeModuleAbi: nodeIdentity.moduleAbi,
    remoteNodePty: "functional",
  };
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [flag, runtimePath] = process.argv.slice(2);
  if (flag !== "--runtime" || runtimePath === undefined || process.argv.length !== 4) throw new Error("usage: audit-linux-package.ts --runtime <directory>");
  const version = path.basename(runtimePath).match(/^vellum-runtime-(.+)-linux-x64$/u)?.[1];
  if (version === undefined) throw new Error("runtime artifact name mismatch");
  process.stdout.write(`${JSON.stringify(await auditLinuxRuntime({ runtimePath, version }))}\n`);
}
