import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxRuntimeArtifactName } from "./finalize-linux-package";
import {
  DEFAULT_NODE_REMOTE_MODULE_ABI,
  DEFAULT_NODE_REMOTE_VERSION,
  LINUX_NODE_PTY_RUNTIME_FILES,
  PINNED_NODE_LINUX_X64_ARCHIVE_SHA256,
} from "./build-linux-remote-runtime";

export const LINUX_RUNTIME_AUDIT_SCHEMA =
  "vellum-command/linux-runtime-audit/v2" as const;
export const LINUX_RUNTIME_REQUIRED_FILES = [
  "vellum-command",
  "resources/app.asar",
  "resources/bin/vellum-command",
  "resources/bin/vellum-command-remote",
  "resources/bin/node",
  "resources/bin/unix-peer-pid.py",
  "resources/app-remote/vellum-command-remote.js",
  "resources/app-remote/package.json",
  "resources/app-remote/package-runtime-provenance.json",
  "resources/systemd/vellum-command-remote-launch",
  "resources/systemd/vellum-command-remote.service.template",
] as const;

export const LINUX_REMOTE_APP_EXACT_FILES = [
  "resources/app-remote/vellum-command-remote.js",
  "resources/app-remote/package.json",
  "resources/app-remote/package-runtime-provenance.json",
  ...LINUX_NODE_PTY_RUNTIME_FILES.map(
    (file) => `resources/app-remote/node_modules/node-pty/${file}`,
  ),
] as const;

export const LINUX_REMOTE_CLOSURE_EXACT_FILES = [
  "resources/bin/node",
  "resources/bin/vellum-command-remote",
  ...LINUX_REMOTE_APP_EXACT_FILES,
  "resources/systemd/vellum-command-remote-launch",
  "resources/systemd/vellum-command-remote.service.template",
] as const;

const FORBIDDEN_SEGMENTS = new Set([
  "chrome-sandbox",
  "apparmor-profile",
  "vellum-release-installer",
  "vellum-release-bridge",
  "sudoers",
  "before-install.sh",
  "after-install.sh",
  "before-remove.sh",
  "after-remove.sh",
]);
const SHA256 = /^[0-9a-f]{64}$/u;

export type LinuxRuntimeInventoryEntry = {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sha256: string;
};

export type LinuxRuntimeInventory = {
  readonly schema: "vellum-command/linux-runtime-inventory/v1";
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly rootSha256: string;
  readonly entries: ReadonlyArray<LinuxRuntimeInventoryEntry>;
};

export const validateElfX64 = (header: Uint8Array, label: string): void => {
  if (
    header.length < 20 ||
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[18] !== 0x3e ||
    header[19] !== 0
  ) {
    throw new Error(`${label} is not little-endian x86-64 ELF`);
  }
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

const walk = async (
  root: string,
  relative = "",
): Promise<LinuxRuntimeInventoryEntry[]> => {
  const result: LinuxRuntimeInventoryEntry[] = [];
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      entry.name.length === 0 ||
      entry.name === "." ||
      entry.name === ".." ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0")
    ) {
      throw new Error("runtime contains an unsafe path segment");
    }
    const child = path.posix.join(relative, entry.name);
    const absolute = path.join(root, child);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`runtime contains symlink: ${child}`);
    }
    if (metadata.isDirectory()) {
      result.push(...(await walk(root, child)));
    } else if (metadata.isFile()) {
      result.push({
        path: child,
        bytes: metadata.size,
        mode: metadata.mode & 0o7777,
        sha256: await sha256File(absolute),
      });
    } else {
      throw new Error(`runtime contains unsupported entry: ${child}`);
    }
  }
  return result;
};

export const linuxRuntimeInventoryRoot = (
  entries: ReadonlyArray<LinuxRuntimeInventoryEntry>,
): string => {
  const hash = createHash("sha256");
  hash.update("vellum-command/linux-runtime-inventory/v1\0");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.bytes));
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
};

export const collectLinuxRuntimeInventory = async (
  runtimePath: string,
): Promise<LinuxRuntimeInventory> => {
  const root = path.resolve(runtimePath);
  const rootMetadata = await lstat(root).catch(() => undefined);
  if (
    rootMetadata === undefined ||
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink()
  ) {
    throw new Error(`Linux runtime root must be a non-symlink directory: ${root}`);
  }
  const entries = await walk(root);
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Linux runtime inventory contains duplicate paths");
  }
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (!paths.every((value, index) => value === sorted[index])) {
    throw new Error("Linux runtime inventory is not sorted");
  }
  return {
    schema: "vellum-command/linux-runtime-inventory/v1",
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    rootSha256: linuxRuntimeInventoryRoot(entries),
    entries,
  };
};

const isAlternateRemotePath = (candidate: string): boolean => {
  const parts = candidate.split("/");
  const basename = parts.at(-1) ?? "";
  if (parts.includes("app-remote") && !candidate.startsWith("resources/app-remote/")) {
    return true;
  }
  if (
    basename === "vellum-command-remote.js" &&
    candidate !== "resources/app-remote/vellum-command-remote.js"
  ) {
    return true;
  }
  if (
    basename === "vellum-command-remote" &&
    candidate !== "resources/bin/vellum-command-remote"
  ) {
    return true;
  }
  if (
    basename === "package-runtime-provenance.json" &&
    candidate !== "resources/app-remote/package-runtime-provenance.json"
  ) {
    return true;
  }
  if (
    basename === "vellum-command-remote-launch" &&
    candidate !== "resources/systemd/vellum-command-remote-launch"
  ) {
    return true;
  }
  if (
    basename === "vellum-command-remote.service.template" &&
    candidate !== "resources/systemd/vellum-command-remote.service.template"
  ) {
    return true;
  }
  return parts.some(
    (part, index) => part === "out" && parts[index + 1] === "remote",
  );
};

export const requireExactLinuxRemoteClosure = (
  inventory: LinuxRuntimeInventory,
): ReadonlyArray<LinuxRuntimeInventoryEntry> => {
  const byPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  for (const required of LINUX_RUNTIME_REQUIRED_FILES) {
    if (!byPath.has(required)) {
      throw new Error(`runtime required file missing: ${required}`);
    }
  }
  const actualAppRemote = inventory.entries
    .map((entry) => entry.path)
    .filter((entry) => entry.startsWith("resources/app-remote/"));
  const expectedAppRemote = [...LINUX_REMOTE_APP_EXACT_FILES].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    actualAppRemote.length !== expectedAppRemote.length ||
    !actualAppRemote.every((entry, index) => entry === expectedAppRemote[index])
  ) {
    const extra = actualAppRemote.find((entry) => !expectedAppRemote.includes(entry));
    const missing = expectedAppRemote.find((entry) => !actualAppRemote.includes(entry));
    throw new Error(
      `Linux app-remote closure is not exact${extra === undefined ? "" : `; extra ${extra}`}${missing === undefined ? "" : `; missing ${missing}`}`,
    );
  }
  const alternate = inventory.entries.find((entry) =>
    isAlternateRemotePath(entry.path),
  );
  if (alternate !== undefined) {
    throw new Error(`alternate Linux Remote copy is forbidden: ${alternate.path}`);
  }
  const closure = LINUX_REMOTE_CLOSURE_EXACT_FILES.map((file) => {
    const entry = byPath.get(file);
    if (entry === undefined) {
      throw new Error(`Linux Remote closure file missing: ${file}`);
    }
    return entry;
  });
  return [...closure].sort((left, right) => left.path.localeCompare(right.path));
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
};

const asInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`invalid ${label}`);
  }
  return Number(value);
};

export const validateLinuxRuntimeInventory = (
  input: unknown,
): LinuxRuntimeInventory => {
  const record = asRecord(input, "Linux runtime inventory");
  if (record.schema !== "vellum-command/linux-runtime-inventory/v1") {
    throw new Error("invalid Linux runtime inventory schema");
  }
  if (!Array.isArray(record.entries)) {
    throw new Error("Linux runtime inventory has no entries");
  }
  const entries = record.entries.map((raw, index) => {
    const entry = asRecord(raw, `Linux runtime inventory entry ${String(index)}`);
    const entryPath = asString(entry.path, "Linux runtime inventory path");
    if (
      entryPath.startsWith("/") ||
      entryPath.includes("\\") ||
      entryPath.includes("\0") ||
      entryPath
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new Error(`unsafe Linux runtime inventory path: ${entryPath}`);
    }
    const digest = asString(entry.sha256, "Linux runtime entry SHA-256");
    if (!SHA256.test(digest)) {
      throw new Error("invalid Linux runtime entry SHA-256");
    }
    return {
      path: entryPath,
      bytes: asInteger(entry.bytes, "Linux runtime entry bytes"),
      mode: asInteger(entry.mode, "Linux runtime entry mode"),
      sha256: digest,
    };
  });
  const sorted = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (
    new Set(entries.map((entry) => entry.path)).size !== entries.length ||
    !entries.every((entry, index) => entry.path === sorted[index]?.path)
  ) {
    throw new Error("Linux runtime inventory paths must be unique and sorted");
  }
  const inventory: LinuxRuntimeInventory = {
    schema: "vellum-command/linux-runtime-inventory/v1",
    fileCount: asInteger(record.fileCount, "Linux runtime file count"),
    totalBytes: asInteger(record.totalBytes, "Linux runtime total bytes"),
    rootSha256: asString(record.rootSha256, "Linux runtime inventory root"),
    entries,
  };
  if (
    inventory.fileCount !== entries.length ||
    inventory.totalBytes !== entries.reduce((sum, entry) => sum + entry.bytes, 0) ||
    inventory.rootSha256 !== linuxRuntimeInventoryRoot(entries)
  ) {
    throw new Error("Linux runtime inventory aggregate does not match entries");
  }
  return inventory;
};

export const decodeLinuxRuntimeAuditReceipt = (
  input: unknown,
): LinuxRuntimeAuditReceipt => {
  const record = asRecord(input, "Linux runtime audit receipt");
  if (record.schema !== LINUX_RUNTIME_AUDIT_SCHEMA || record.ok !== true) {
    throw new Error("invalid Linux runtime audit receipt schema");
  }
  const inventory = validateLinuxRuntimeInventory(record.inventory);
  const expectedRemote = requireExactLinuxRemoteClosure(inventory);
  const remote = asRecord(record.remoteClosure, "Linux Remote closure");
  if (remote.exact !== true || !Array.isArray(remote.entries)) {
    throw new Error("Linux Remote closure is not exact");
  }
  const remoteInventory = validateLinuxRuntimeInventory({
    schema: "vellum-command/linux-runtime-inventory/v1",
    fileCount: remote.entries.length,
    totalBytes: remote.entries.reduce((sum: number, raw: unknown) => {
      const item = asRecord(raw, "Linux Remote closure entry");
      return sum + asInteger(item.bytes, "Linux Remote closure bytes");
    }, 0),
    rootSha256: linuxRuntimeInventoryRoot(
      remote.entries.map((raw: unknown) => {
        const item = asRecord(raw, "Linux Remote closure entry");
        return {
          path: asString(item.path, "Linux Remote closure path"),
          bytes: asInteger(item.bytes, "Linux Remote closure bytes"),
          mode: asInteger(item.mode, "Linux Remote closure mode"),
          sha256: asString(item.sha256, "Linux Remote closure SHA-256"),
        };
      }),
    ),
    entries: remote.entries,
  });
  if (
    JSON.stringify(remoteInventory.entries) !== JSON.stringify(expectedRemote) ||
    asString(remote.rootSha256, "Linux Remote closure root") !==
      linuxRemoteClosureRoot(expectedRemote)
  ) {
    throw new Error("Linux Remote closure receipt does not match runtime inventory");
  }
  const stockNode = asRecord(record.stockNode, "stock Node audit");
  const nodePty = asRecord(record.nodePty, "node-pty audit");
  if (
    stockNode.source !== "pinned-official-nodejs-linux-x64-archive" ||
    stockNode.version !== DEFAULT_NODE_REMOTE_VERSION ||
    stockNode.moduleAbi !== DEFAULT_NODE_REMOTE_MODULE_ABI ||
    nodePty.execution !== "functional"
  ) {
    throw new Error("Linux runtime execution audit facts are incomplete");
  }
  for (const [label, value] of [
    ["official Node archive", stockNode.officialArchiveSha256],
    ["bundled Node binary", stockNode.binarySha256],
    ["node-pty native module", nodePty.nativeModuleSha256],
  ] as const) {
    if (typeof value !== "string" || !SHA256.test(value)) {
      throw new Error(`invalid ${label} SHA-256`);
    }
  }
  if (!Array.isArray(record.nativeObjects) || record.chromeSandbox !== "absent") {
    throw new Error("Linux native audit facts are incomplete");
  }
  return record as unknown as LinuxRuntimeAuditReceipt;
};

export const validateUserServiceTemplate = (input: string): void => {
  if (
    !input.includes(
      "ExecStart=@VELLUM_COMMAND_RUNTIME_ROOT@/resources/systemd/vellum-command-remote-launch\n",
    )
  ) {
    throw new Error("user service must retain the runtime-root placeholder");
  }
  if (
    /^\s*(?:User|Group|CapabilityBoundingSet|AmbientCapabilities|NoNewPrivileges)=/mu.test(
      input,
    )
  ) {
    throw new Error("user service contains privileged directives");
  }
};

const requireLoadable = (file: string): void => {
  const result = spawnSync("/usr/bin/ldd", [file], {
    encoding: "utf8",
    shell: false,
  });
  if (
    result.status !== 0 ||
    /not found/u.test(`${result.stdout}\n${result.stderr}`)
  ) {
    throw new Error(`native runtime dependency is unavailable: ${file}`);
  }
};

export const validateBundledNodeVersion = (output: string): string => {
  const actual = output.trim();
  const expected = `v${DEFAULT_NODE_REMOTE_VERSION}`;
  if (actual !== expected) {
    throw new Error(
      `bundled Node version mismatch: expected ${expected}, got ${actual || "empty"}`,
    );
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
      "JSON.stringify({node:process.versions.node,modules:process.versions.modules})",
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

export type LinuxRuntimeAuditReceipt = {
  readonly schema: typeof LINUX_RUNTIME_AUDIT_SCHEMA;
  readonly ok: true;
  readonly artifact: string;
  readonly inventory: LinuxRuntimeInventory;
  readonly remoteClosure: {
    readonly exact: true;
    readonly entries: ReadonlyArray<LinuxRuntimeInventoryEntry>;
    readonly rootSha256: string;
  };
  readonly nativeObjects: ReadonlyArray<string>;
  readonly chromeSandbox: "absent";
  readonly stockNode: {
    readonly source: "pinned-official-nodejs-linux-x64-archive";
    readonly version: string;
    readonly moduleAbi: string;
    readonly officialArchiveSha256: string;
    readonly binarySha256: string;
  };
  readonly nodePty: {
    readonly version: string;
    readonly execution: "functional";
    readonly nativeModuleSha256: string;
  };
};

export const linuxRemoteClosureRoot = (
  entries: ReadonlyArray<LinuxRuntimeInventoryEntry>,
): string => {
  const hash = createHash("sha256");
  hash.update("vellum-command/linux-remote-closure/v1\0");
  for (const entry of entries) {
    hash.update(
      `${entry.path}\0${String(entry.bytes)}\0${entry.mode.toString(8)}\0${entry.sha256}\n`,
    );
  }
  return hash.digest("hex");
};

export const auditLinuxRuntime = async ({
  runtimePath,
  version,
}: {
  readonly runtimePath: string;
  readonly version: string;
}): Promise<LinuxRuntimeAuditReceipt> => {
  const root = path.resolve(runtimePath);
  if (
    path.basename(root) !== linuxRuntimeArtifactName({ version, arch: "x64" })
  ) {
    throw new Error("runtime artifact name mismatch");
  }
  const inventory = await collectLinuxRuntimeInventory(root);
  for (const file of inventory.entries) {
    if (
      file.path
        .split("/")
        .some((part) => FORBIDDEN_SEGMENTS.has(part)) ||
      /(?:^|\/)(?:opt|usr|etc|var)(?:\/|$)/u.test(file.path)
    ) {
      throw new Error(`privileged packaging residue: ${file.path}`);
    }
    if ((file.mode & 0o7000) !== 0) {
      throw new Error(`runtime has privileged mode bits: ${file.path}`);
    }
  }
  const remoteClosure = requireExactLinuxRemoteClosure(inventory);
  const nativeObjects: string[] = [];
  for (const file of inventory.entries) {
    const absolute = path.join(root, file.path);
    const header = await readFile(absolute).then((contents) =>
      contents.subarray(0, 20),
    );
    if (
      header[0] === 0x7f &&
      header[1] === 0x45 &&
      header[2] === 0x4c &&
      header[3] === 0x46
    ) {
      validateElfX64(header, file.path);
      nativeObjects.push(file.path);
      requireLoadable(absolute);
    }
  }
  validateUserServiceTemplate(
    await readFile(
      path.join(
        root,
        "resources/systemd/vellum-command-remote.service.template",
      ),
      "utf8",
    ),
  );
  const node = path.join(root, "resources/bin/node");
  const nodeIdentity = requireBundledNodeRuntimeIdentity(node);
  requireRemoteNodePty({
    node,
    nodePtyRoot: path.join(root, "resources/app-remote/node_modules/node-pty"),
  });
  const nodePtyPackage = JSON.parse(
    await readFile(
      path.join(
        root,
        "resources/app-remote/node_modules/node-pty/package.json",
      ),
      "utf8",
    ),
  ) as { readonly version?: unknown };
  if (
    typeof nodePtyPackage.version !== "string" ||
    nodePtyPackage.version.length === 0
  ) {
    throw new Error("packaged node-pty has no version");
  }
  const byPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  const nodeEntry = byPath.get("resources/bin/node");
  const ptyEntry = byPath.get(
    "resources/app-remote/node_modules/node-pty/build/Release/pty.node",
  );
  if (nodeEntry === undefined || ptyEntry === undefined) {
    throw new Error("Linux runtime inventory lost an audited native component");
  }
  const officialArchiveSha256 =
    PINNED_NODE_LINUX_X64_ARCHIVE_SHA256[DEFAULT_NODE_REMOTE_VERSION];
  if (officialArchiveSha256 === undefined || !SHA256.test(officialArchiveSha256)) {
    throw new Error("reviewed stock Node archive digest is missing");
  }
  return {
    schema: LINUX_RUNTIME_AUDIT_SCHEMA,
    ok: true,
    artifact: path.basename(root),
    inventory,
    remoteClosure: {
      exact: true,
      entries: remoteClosure,
      rootSha256: linuxRemoteClosureRoot(remoteClosure),
    },
    nativeObjects,
    chromeSandbox: "absent",
    stockNode: {
      source: "pinned-official-nodejs-linux-x64-archive",
      version: nodeIdentity.nodeVersion,
      moduleAbi: nodeIdentity.moduleAbi,
      officialArchiveSha256,
      binarySha256: nodeEntry.sha256,
    },
    nodePty: {
      version: nodePtyPackage.version,
      execution: "functional",
      nativeModuleSha256: ptyEntry.sha256,
    },
  };
};

export const writeLinuxRuntimeAuditReceipt = async (
  destination: string,
  receipt: LinuxRuntimeAuditReceipt,
): Promise<void> => {
  const target = path.resolve(destination);
  const stage = `${target}.new.${String(process.pid)}.${randomUUID()}`;
  await writeFile(stage, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  try {
    const existing = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) {
      throw new Error(`audit receipt destination already exists: ${target}`);
    }
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { force: true });
    throw error;
  }
};

const parseCli = (
  args: ReadonlyArray<string>,
): { readonly runtime: string; readonly version: string; readonly receipt?: string } => {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "usage: audit-linux-package.ts --runtime PATH [--version VERSION] [--receipt PATH]",
      );
    }
    options.set(flag, value);
  }
  const runtime = options.get("--runtime");
  if (runtime === undefined) {
    throw new Error(
      "usage: audit-linux-package.ts --runtime PATH [--version VERSION] [--receipt PATH]",
    );
  }
  const version =
    options.get("--version") ??
    path.basename(runtime).match(/^vellum-runtime-(.+)-linux-x64$/u)?.[1];
  if (version === undefined) throw new Error("runtime artifact name mismatch");
  return { runtime, version, ...(options.has("--receipt") ? { receipt: options.get("--receipt") } : {}) } as {
    readonly runtime: string;
    readonly version: string;
    readonly receipt?: string;
  };
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const options = parseCli(process.argv.slice(2));
  const receipt = await auditLinuxRuntime({
    runtimePath: options.runtime,
    version: options.version,
  });
  if (options.receipt !== undefined) {
    await writeLinuxRuntimeAuditReceipt(options.receipt, receipt);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
