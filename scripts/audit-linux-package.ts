import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditPackagedLicenseBinding,
  type LicenseBuildAuditReceipt,
} from "./audit-license-build";
import {
  DEFAULT_NODE_REMOTE_VERSION,
  LINUX_REMOTE_RUNTIME_AUDIT_EXPECTED,
  pinnedNodeLinuxX64ArchiveSha256,
  type LinuxRemoteRuntimeAuditReceipt,
  validateLinuxRemoteRuntimeAuditReceipt,
} from "./linux-remote-runtime-contract";
export {
  LINUX_REMOTE_RUNTIME_AUDIT_EXPECTED,
  LINUX_REMOTE_RUNTIME_AUDIT_SCHEMA,
  type LinuxRemoteRuntimeAuditReceipt,
  validateLinuxRemoteRuntimeAuditReceipt,
} from "./linux-remote-runtime-contract";
import { linuxRuntimeArtifactName } from "./finalize-linux-package";

export const LINUX_RUNTIME_REQUIRED_FILES = [
  "vellum",
  "resources/app.asar",
  "resources/bin/vellum",
  "resources/bin/vellum-browser",
  "resources/bin/vellum-station",
  "resources/bin/vellum-remote",
  "resources/bin/node",
  "resources/bin/unix-peer-pid.py",
  "resources/app-remote/vellum-remote.js",
  "resources/systemd/vellum-remote-launch",
  "resources/systemd/vellum-remote.service.template",
] as const;
const FORBIDDEN_SEGMENTS = new Set(["chrome-sandbox", "apparmor-profile", "vellum-release-installer", "vellum-release-bridge", "sudoers", "before-install.sh", "after-install.sh", "before-remove.sh", "after-remove.sh"]);

const REMOTE_RUNTIME_PROBE = String.raw`
"use strict";
const { createRequire } = require("node:module");
const path = require("node:path");

void (async () => {
  const appRemote = process.argv[1];
  if (typeof appRemote !== "string" || !path.isAbsolute(appRemote)) {
    throw new Error("app-remote path is invalid");
  }

  const { DatabaseSync, constants } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  let authorizerCalls = 0;
  try {
    if (typeof database.setAuthorizer !== "function") {
      throw new Error("DatabaseSync.setAuthorizer is unavailable");
    }
    database.setAuthorizer(() => {
      authorizerCalls += 1;
      return constants.SQLITE_OK;
    });
    database.exec(
      "CREATE TABLE runtime_probe(value TEXT NOT NULL); " +
      "INSERT INTO runtime_probe(value) VALUES ('node:sqlite');",
    );
    const row = database
      .prepare("SELECT value FROM runtime_probe")
      .get();
    if (row?.value !== "node:sqlite" || authorizerCalls < 1) {
      throw new Error("node:sqlite authorizer was not exercised");
    }
  } finally {
    if (typeof database.setAuthorizer === "function") {
      database.setAuthorizer(null);
    }
    database.close();
  }

  const requireRemote = createRequire(path.join(appRemote, "package.json"));
  const { Terminal } = requireRemote("@xterm/headless");
  const { SerializeAddon } = requireRemote("@xterm/addon-serialize");
  if (typeof Terminal !== "function" || typeof SerializeAddon !== "function") {
    throw new Error("packaged xterm constructors are unavailable");
  }
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true,
  });
  const serialize = new SerializeAddon();
  try {
    terminal.loadAddon(serialize);
    await new Promise((resolve) => {
      terminal.write("vellum-runtime-probe", resolve);
    });
    if (!serialize.serialize().includes("vellum-runtime-probe")) {
      throw new Error("packaged xterm serialization failed");
    }
  } finally {
    terminal.dispose();
  }

  process.stdout.write(JSON.stringify({
    schema: "vellum/linux-remote-runtime-audit/v1",
    nodeVersion: process.version,
    nodeArchiveSha256: "${pinnedNodeLinuxX64ArchiveSha256(DEFAULT_NODE_REMOTE_VERSION)}",
    nodeSqlite: "exercised",
    sqliteAuthorizer: "exercised",
    xtermHeadless: "exercised",
    xtermSerialize: "exercised",
  }) + "\n");
})().catch((error) => {
  process.stderr.write(
    "packaged Remote runtime probe failed: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
`;

export const auditBundledRemoteRuntime = (
  runtimeRoot: string,
): LinuxRemoteRuntimeAuditReceipt => {
  const root = path.resolve(runtimeRoot);
  const executable = path.join(root, "resources/bin/node");
  const appRemote = path.join(root, "resources/app-remote");
  const result = spawnSync(
    executable,
    ["-e", REMOTE_RUNTIME_PROBE, appRemote],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      env: {
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("packaged Remote runtime probe did not execute");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse((result.stdout ?? "").trim());
  } catch {
    throw new Error("packaged Remote runtime probe emitted malformed JSON");
  }
  return validateLinuxRemoteRuntimeAuditReceipt(decoded);
};

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

export const validatePackagedCliVersion = (
  output: string,
  expectedVersion: string,
): string => {
  const version = output.trim();
  if (version !== expectedVersion) {
    throw new Error(
      `packaged vellum CLI version mismatch: expected ${expectedVersion}, got ${version || "<empty>"}`,
    );
  }
  return version;
};

const auditPackagedCliVersion = (
  executable: string,
  expectedVersion: string,
): string => {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    env: {
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("packaged vellum CLI did not execute for version audit");
  }
  return validatePackagedCliVersion(result.stdout ?? "", expectedVersion);
};

const requireLoadable = (file: string, relative: string): void => {
  // electron-builder may ship dual musl/glibc optional natives; only the host
  // ABI is loadable here. musl .node files must not fail a glibc package audit.
  if (/(?:^|\/|\.)musl(?:\.|\/|$)/u.test(relative)) return;
  const result = spawnSync("/usr/bin/ldd", [file], { encoding: "utf8", shell: false });
  if (result.status !== 0 || /not found/u.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`native runtime dependency is unavailable: ${file}`);
};

export const auditLinuxRuntime = async ({ runtimePath, version }: { readonly runtimePath: string; readonly version: string }): Promise<{ readonly ok: true; readonly artifact: string; readonly cliVersion: string; readonly remoteRuntime: LinuxRemoteRuntimeAuditReceipt; readonly nativeObjects: ReadonlyArray<string>; readonly chromeSandbox: "absent"; readonly license: LicenseBuildAuditReceipt }> => {
  const root = path.resolve(runtimePath);
  if (path.basename(root) !== linuxRuntimeArtifactName({ version, arch: "x64" })) throw new Error("runtime artifact name mismatch");
  const files = await walk(root);
  for (const required of LINUX_RUNTIME_REQUIRED_FILES) if (!files.includes(required)) throw new Error(`runtime required file missing: ${required}`);
  const cliVersion = auditPackagedCliVersion(
    path.join(root, "resources/bin/vellum"),
    version,
  );
  const remoteRuntime = auditBundledRemoteRuntime(root);
  // Final packaged ASAR license binding — malformed binding must fail the audit.
  const appAsarPath = path.join(root, "resources/app.asar");
  const license = auditPackagedLicenseBinding(appAsarPath);
  for (const file of files) if (file.split("/").some((part) => FORBIDDEN_SEGMENTS.has(part)) || /(?:^|\/)(?:opt|usr|etc|var)(?:\/|$)/u.test(file)) throw new Error(`privileged packaging residue: ${file}`);
  const nativeObjects: string[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const metadata = await lstat(absolute);
    if ((metadata.mode & 0o7000) !== 0) throw new Error(`runtime has privileged mode bits: ${file}`);
    const header = await readFile(absolute).then((contents) => contents.subarray(0, 20));
    if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
      validateElfX64(header, file); nativeObjects.push(file);
      // ET_REL (.o) is not a loadable image; only ET_EXEC/ET_DYN need ldd.
      const elfType = header[16] | (header[17]! << 8);
      if (elfType === 2 || elfType === 3) requireLoadable(absolute, file);
    }
  }
  validateUserServiceTemplate(await readFile(path.join(root, "resources/systemd/vellum-remote.service.template"), "utf8"));
  return { ok: true, artifact: path.basename(root), cliVersion, remoteRuntime, nativeObjects, chromeSandbox: "absent", license };
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [flag, runtimePath] = process.argv.slice(2);
  if (flag !== "--runtime" || runtimePath === undefined || process.argv.length !== 4) throw new Error("usage: audit-linux-package.ts --runtime <directory>");
  const version = path.basename(runtimePath).match(/^vellum-runtime-(.+)-linux-x64$/u)?.[1];
  if (version === undefined) throw new Error("runtime artifact name mismatch");
  try {
    process.stdout.write(`${JSON.stringify(await auditLinuxRuntime({ runtimePath, version }))}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`vellum linux package audit failed: ${message}\n`);
    process.exitCode = 1;
  }
}
