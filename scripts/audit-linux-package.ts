import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
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

export const LINUX_RUNTIME_AUDIT_SCHEMA =
  "junto/linux-runtime-audit/v3" as const;
export const LINUX_RUNTIME_REQUIRED_FILES = [
  "junto",
  "resources/app.asar",
  "resources/bin/junto",
  "resources/bin/unix-peer-pid.py",
] as const;

const FORBIDDEN_SEGMENTS = new Set([
  "chrome-sandbox",
  "apparmor-profile",
  "junto-release-installer",
  "junto-release-bridge",
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
  readonly schema: "junto/linux-runtime-inventory/v1";
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

/**
 * One locale-independent total order for inventory paths. Locale collation
 * ranks "/" and "-" differently per host, so a per-directory name sort and a
 * full-path sort disagree under ICU; code-point order agrees everywhere.
 */
const byCodePoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const walk = async (
  root: string,
  relative = "",
): Promise<LinuxRuntimeInventoryEntry[]> => {
  const result: LinuxRuntimeInventoryEntry[] = [];
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  entries.sort((left, right) => byCodePoint(left.name, right.name));
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
  hash.update("junto/linux-runtime-inventory/v1\0");
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
  const entries = (await walk(root)).sort((left, right) =>
    byCodePoint(left.path, right.path),
  );
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Linux runtime inventory contains duplicate paths");
  }
  return {
    schema: "junto/linux-runtime-inventory/v1",
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    rootSha256: linuxRuntimeInventoryRoot(entries),
    entries,
  };
};

export const requireLinuxRuntimeFiles = (
  inventory: LinuxRuntimeInventory,
): void => {
  const paths = new Set(inventory.entries.map((entry) => entry.path));
  for (const required of LINUX_RUNTIME_REQUIRED_FILES) {
    if (!paths.has(required)) {
      throw new Error(`runtime required file missing: ${required}`);
    }
  }
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
  if (record.schema !== "junto/linux-runtime-inventory/v1") {
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
    byCodePoint(left.path, right.path),
  );
  if (
    new Set(entries.map((entry) => entry.path)).size !== entries.length ||
    !entries.every((entry, index) => entry.path === sorted[index]?.path)
  ) {
    throw new Error("Linux runtime inventory paths must be unique and sorted");
  }
  const inventory: LinuxRuntimeInventory = {
    schema: "junto/linux-runtime-inventory/v1",
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
  requireLinuxRuntimeFiles(validateLinuxRuntimeInventory(record.inventory));
  if (!Array.isArray(record.nativeObjects) || record.chromeSandbox !== "absent") {
    throw new Error("Linux native audit facts are incomplete");
  }
  return record as unknown as LinuxRuntimeAuditReceipt;
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

export type LinuxRuntimeAuditReceipt = {
  readonly schema: typeof LINUX_RUNTIME_AUDIT_SCHEMA;
  readonly ok: true;
  readonly artifact: string;
  readonly inventory: LinuxRuntimeInventory;
  readonly nativeObjects: ReadonlyArray<string>;
  readonly chromeSandbox: "absent";
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
  requireLinuxRuntimeFiles(inventory);
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
  return {
    schema: LINUX_RUNTIME_AUDIT_SCHEMA,
    ok: true,
    artifact: path.basename(root),
    inventory,
    nativeObjects,
    chromeSandbox: "absent",
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
    path.basename(runtime).match(/^junto-runtime-(.+)-linux-x64$/u)?.[1];
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
