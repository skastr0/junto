/**
 * Stage the displayless Linux Remote runtime into an electron-builder
 * linux-unpacked (or finalized) tree:
 *
 *   resources/bin/node              — official Node linux-x64 binary
 *   resources/bin/vellum-remote     — wrapper that exec's bundled node on the entry
 *   resources/app-remote/…          — remote JS entry + node-pty rebuilt for Node ABI
 *
 * Product remote is Node, never ELECTRON_RUN_AS_NODE and never Bun-compile.
 * Full download + node-pty rebuild only runs on Linux x64; pure helpers are
 * unit-tested on any host.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Pinned Node for the product Remote. Override with NODE_REMOTE_VERSION. */
export const DEFAULT_NODE_REMOTE_VERSION = "22.18.0";

export const REMOTE_NODE_RELATIVE = "resources/bin/node";
export const REMOTE_WRAPPER_RELATIVE = "resources/bin/vellum-remote";
export const REMOTE_APP_DIR_RELATIVE = "resources/app-remote";
export const REMOTE_ENTRY_RELATIVE = "resources/app-remote/vellum-remote.js";
export const REMOTE_NODE_PTY_RELATIVE =
  "resources/app-remote/node_modules/node-pty";

/** Repo-side build output copied into the runtime when present. */
export const REMOTE_ENTRY_SOURCE_RELATIVE = "out/remote/vellum-remote.js";

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const requireNodeRemoteVersion = (value: unknown): string => {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(
      `invalid NODE_REMOTE_VERSION (need semver x.y.z): ${String(value)}`,
    );
  }
  const major = Number(value.split(".")[0]);
  if (major !== 22) {
    throw new Error(
      `NODE_REMOTE_VERSION must be Node 22 LTS (got ${value}); remote ABI is pinned to 22.x`,
    );
  }
  return value;
};

export const resolveNodeRemoteVersion = (
  env: NodeJS.ProcessEnv = process.env,
): string =>
  requireNodeRemoteVersion(
    env.NODE_REMOTE_VERSION?.trim() || DEFAULT_NODE_REMOTE_VERSION,
  );

export const nodeLinuxX64ArchiveName = (version: string): string =>
  `node-v${requireNodeRemoteVersion(version)}-linux-x64.tar.gz`;

export const nodeLinuxX64ArchiveUrl = (version: string): string =>
  `https://nodejs.org/dist/v${requireNodeRemoteVersion(version)}/${nodeLinuxX64ArchiveName(version)}`;

/**
 * Wrapper executed as resources/bin/vellum-remote. Resolves the release root
 * from argv0, never uses system node, never sets ELECTRON_RUN_AS_NODE.
 */
export const vellumRemoteWrapperScript = (): string => `#!/bin/sh
# Displayless product Remote: bundled Node + app-remote entry. No system Node,
# no Bun compile, no ELECTRON_RUN_AS_NODE.
set -eu
fail() { printf '%s\\n' "vellum-remote: $1" >&2; exit "\${2:-69}"; }
case "\${0}" in
  */resources/bin/vellum-remote) release=\${0%/resources/bin/vellum-remote} ;;
  *) fail 'launcher path is not a release resource' 73 ;;
esac
case "$release" in
  /*) ;;
  *) fail 'release root must be absolute' 73 ;;
esac
node="$release/${REMOTE_NODE_RELATIVE}"
entry="$release/${REMOTE_ENTRY_RELATIVE}"
[ -f "$node" ] && [ -x "$node" ] || fail 'bundled Node is missing or not executable'
[ -f "$entry" ] || fail 'remote entry is missing: ${REMOTE_ENTRY_RELATIVE}'
# Prefer release-local node_modules so node-pty resolves to the Node-ABI rebuild.
export NODE_PATH="$release/${REMOTE_APP_DIR_RELATIVE}/node_modules\${NODE_PATH:+:$NODE_PATH}"
unset ELECTRON_RUN_AS_NODE
exec "$node" "$entry" "$@"
`;

export const remoteEntryMissingMessage = (entrySource: string): string =>
  [
    "Linux remote runtime requires a displayless Node entry before packaging.",
    `Missing: ${entrySource}`,
    "Build out/remote/vellum-remote.js (product remote JS).",
    "Forbidden product paths: Bun --compile remote, ELECTRON_RUN_AS_NODE, system Node.",
  ].join(" ");

const isNonSymlinkDirectory = async (target: string): Promise<boolean> => {
  try {
    const metadata = await lstat(target);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
};

const isNonSymlinkFile = async (target: string): Promise<boolean> => {
  try {
    const metadata = await lstat(target);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
};

const assertLinuxX64Builder = (): void => {
  if (process.platform !== "linux") {
    throw new Error(
      "build-linux-remote-runtime full stage requires Linux (pure helpers are OS-portable)",
    );
  }
  if (process.arch !== "x64") {
    throw new Error("Linux remote runtime requires x64 builder host");
  }
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): void => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ""}`.trim();
    throw new Error(
      `command failed (${command} ${args.join(" ")}): ${detail || `exit ${String(result.status)}`}`,
    );
  }
};

const downloadToFile = async (url: string, destination: string): Promise<void> => {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`failed to download ${url}: HTTP ${String(response.status)}`);
  }
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(destination));
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
};

export const extractNodeBinaryFromArchive = ({
  archive,
  destinationNode,
  version,
}: {
  readonly archive: string;
  readonly destinationNode: string;
  readonly version: string;
}): void => {
  const archiveName = nodeLinuxX64ArchiveName(version);
  const member = `node-v${requireNodeRemoteVersion(version)}-linux-x64/bin/node`;
  const stagingParent = path.dirname(destinationNode);
  // Extract only bin/node into a temp dir under the destination parent, then move.
  const extractRoot = path.join(
    stagingParent,
    `.node-extract-${requireNodeRemoteVersion(version)}`,
  );
  run("/usr/bin/rm", ["-rf", extractRoot]);
  run("/usr/bin/mkdir", ["-p", extractRoot]);
  try {
    run("/usr/bin/tar", [
      "--extract",
      "--gzip",
      "--file",
      archive,
      "--directory",
      extractRoot,
      member,
    ]);
    const extracted = path.join(extractRoot, member);
    run("/usr/bin/mkdir", ["-p", stagingParent]);
    run("/usr/bin/cp", ["-f", extracted, destinationNode]);
    run("/usr/bin/chmod", ["0755", destinationNode]);
  } finally {
    run("/usr/bin/rm", ["-rf", extractRoot]);
  }
  // Silence unused name (kept for error context / future checksum table).
  void archiveName;
};

/**
 * Resolve where to cache official Node tarballs. Prefer an explicit cache root,
 * else <repo>/release/.cache/node, else OS temp.
 */
export const resolveNodeDownloadCache = (input: {
  readonly repoRoot: string;
  readonly cacheRoot?: string;
}): string => {
  if (input.cacheRoot !== undefined && input.cacheRoot.length > 0) {
    return path.resolve(input.cacheRoot);
  }
  return path.join(path.resolve(input.repoRoot), "release", ".cache", "node");
};

export const stageOfficialNodeBinary = async (input: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly version: string;
  readonly cacheRoot?: string;
  /** Inject download for tests; production uses fetch. */
  readonly download?: (url: string, destination: string) => Promise<void>;
}): Promise<{ readonly nodePath: string; readonly version: string; readonly archiveSha256: string }> => {
  const version = requireNodeRemoteVersion(input.version);
  const cache = resolveNodeDownloadCache({
    repoRoot: input.repoRoot,
    cacheRoot: input.cacheRoot,
  });
  await mkdir(cache, { recursive: true, mode: 0o755 });
  const archive = path.join(cache, nodeLinuxX64ArchiveName(version));
  if (!(await isNonSymlinkFile(archive))) {
    const url = nodeLinuxX64ArchiveUrl(version);
    const partial = `${archive}.partial`;
    await rm(partial, { force: true });
    const download = input.download ?? downloadToFile;
    await download(url, partial);
    await chmod(partial, 0o644);
    // Atomic-ish publish into cache.
    run("/usr/bin/mv", ["-f", partial, archive]);
  }
  const archiveSha256 = await sha256File(archive);
  const nodePath = path.join(input.runtimeRoot, REMOTE_NODE_RELATIVE);
  await mkdir(path.dirname(nodePath), { recursive: true, mode: 0o755 });
  extractNodeBinaryFromArchive({ archive, destinationNode: nodePath, version });
  return { nodePath, version, archiveSha256 };
};

const walkFiles = async (root: string, relative = ""): Promise<string[]> => {
  const result: string[] = [];
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.posix.join(relative, entry.name);
    const absolute = path.join(root, childRelative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`node-pty stage contains symlink: ${childRelative}`);
    }
    if (metadata.isDirectory()) {
      result.push(...(await walkFiles(root, childRelative)));
    } else if (metadata.isFile()) {
      result.push(childRelative);
    }
  }
  return result;
};

/**
 * Copy production node-pty sources into the remote tree and rebuild for the
 * bundled Node ABI (not Electron). Linux x64 only.
 */
export const stageNodePtyForBundledNode = async (input: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly bundledNode: string;
  readonly nodeVersion: string;
}): Promise<{ readonly nodePtyRoot: string; readonly nativeModule: string }> => {
  assertLinuxX64Builder();
  const sourcePty = path.join(input.repoRoot, "node_modules", "node-pty");
  if (!(await isNonSymlinkDirectory(sourcePty))) {
    throw new Error("node-pty is missing from node_modules — run bun install");
  }
  const destPty = path.join(input.runtimeRoot, REMOTE_NODE_PTY_RELATIVE);
  await rm(destPty, { recursive: true, force: true });
  await mkdir(path.dirname(destPty), { recursive: true, mode: 0o755 });
  // Copy package without host build/ and foreign prebuilds; rebuild clean.
  await cp(sourcePty, destPty, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourcePty, source).split(path.sep).join("/");
      if (relative === "build" || relative.startsWith("build/")) return false;
      if (relative === "prebuilds" || relative.startsWith("prebuilds/")) return false;
      return true;
    },
  });

  const nodeGyp = path.join(
    input.repoRoot,
    "node_modules",
    "node-gyp",
    "bin",
    "node-gyp.js",
  );
  if (!(await isNonSymlinkFile(nodeGyp))) {
    throw new Error("node-gyp missing — expected via @electron/rebuild dependency tree");
  }
  const version = requireNodeRemoteVersion(input.nodeVersion);
  // Rebuild against official Node headers for the bundled runtime ABI.
  run(
    input.bundledNode,
    [
      nodeGyp,
      "rebuild",
      `--target=${version}`,
      "--arch=x64",
      "--dist-url=https://nodejs.org/dist",
    ],
    {
      cwd: destPty,
      env: {
        ...process.env,
        npm_config_build_from_source: "true",
        // Keep the child on a minimal, non-Electron identity.
        ELECTRON_RUN_AS_NODE: "",
      },
    },
  );

  const nativeCandidates = [
    path.join(destPty, "build", "Release", "pty.node"),
    path.join(destPty, "prebuilds", "linux-x64", "pty.node"),
  ];
  let nativeModule: string | undefined;
  for (const candidate of nativeCandidates) {
    if (await isNonSymlinkFile(candidate)) {
      nativeModule = candidate;
      break;
    }
  }
  if (nativeModule === undefined) {
    throw new Error("node-pty rebuild for bundled Node produced no pty.node");
  }
  const spawnHelper = path.join(path.dirname(nativeModule), "spawn-helper");
  if (await isNonSymlinkFile(spawnHelper)) {
    await chmod(spawnHelper, 0o755);
  }
  await chmod(nativeModule, 0o755);
  // Drop anything that is not needed at runtime to keep the archive lean.
  for (const relative of await walkFiles(destPty)) {
    if (
      relative.endsWith(".ts") ||
      relative.endsWith(".map") ||
      relative.startsWith("src/") ||
      relative.startsWith("deps/") ||
      relative.startsWith("third_party/")
    ) {
      // Keep binding.gyp-adjacent sources only if present; runtime loads lib/ + native.
      // Source tree can stay — size is secondary to correctness. No-op strip for v1.
      void relative;
    }
  }
  return { nodePtyRoot: destPty, nativeModule };
};

export const stageRemoteEntry = async (input: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly entrySourceRelative?: string;
}): Promise<{ readonly entryPath: string }> => {
  const sourceRelative =
    input.entrySourceRelative ?? REMOTE_ENTRY_SOURCE_RELATIVE;
  const source = path.join(input.repoRoot, sourceRelative);
  if (!(await isNonSymlinkFile(source))) {
    throw new Error(remoteEntryMissingMessage(sourceRelative));
  }
  const destination = path.join(input.runtimeRoot, REMOTE_ENTRY_RELATIVE);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
  await chmod(destination, 0o644);
  return { entryPath: destination };
};

export const stageVellumRemoteWrapper = async (
  runtimeRoot: string,
): Promise<{ readonly wrapperPath: string }> => {
  const wrapperPath = path.join(runtimeRoot, REMOTE_WRAPPER_RELATIVE);
  await mkdir(path.dirname(wrapperPath), { recursive: true, mode: 0o755 });
  await writeFile(wrapperPath, vellumRemoteWrapperScript(), {
    encoding: "utf8",
    mode: 0o755,
  });
  await chmod(wrapperPath, 0o755);
  return { wrapperPath };
};

export type LinuxRemoteRuntimeReceipt = {
  readonly ok: true;
  readonly nodeVersion: string;
  readonly nodePath: string;
  readonly wrapperPath: string;
  readonly entryPath: string;
  readonly nodePtyRoot: string;
  readonly nativeModule: string;
  readonly archiveSha256: string;
};

/**
 * Full stage into an existing linux-unpacked / runtime root.
 * Fails closed when the remote JS entry is missing.
 */
export const installLinuxRemoteRuntime = async (input: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly nodeVersion?: string;
  readonly cacheRoot?: string;
  readonly entrySourceRelative?: string;
  /** When true (default), require out/remote entry. Set false only for helper tests. */
  readonly requireEntry?: boolean;
  readonly download?: (url: string, destination: string) => Promise<void>;
  /** Skip native rebuild — only for pure-layout unit tests, never packaging. */
  readonly skipNativeRebuild?: boolean;
}): Promise<LinuxRemoteRuntimeReceipt> => {
  const repoRoot = path.resolve(input.repoRoot);
  const runtimeRoot = path.resolve(input.runtimeRoot);
  if (!(await isNonSymlinkDirectory(runtimeRoot))) {
    throw new Error(`runtime root missing or not a directory: ${runtimeRoot}`);
  }
  const nodeVersion = requireNodeRemoteVersion(
    input.nodeVersion ?? resolveNodeRemoteVersion(),
  );
  const requireEntry = input.requireEntry !== false;

  const { wrapperPath } = await stageVellumRemoteWrapper(runtimeRoot);

  let entryPath = path.join(runtimeRoot, REMOTE_ENTRY_RELATIVE);
  if (requireEntry) {
    ({ entryPath } = await stageRemoteEntry({
      repoRoot,
      runtimeRoot,
      entrySourceRelative: input.entrySourceRelative,
    }));
  } else {
    await mkdir(path.dirname(entryPath), { recursive: true, mode: 0o755 });
  }

  // Node binary + node-pty native rebuild only on Linux packaging hosts.
  if (process.platform !== "linux" || process.arch !== "x64") {
    if (input.skipNativeRebuild === true) {
      return {
        ok: true,
        nodeVersion,
        nodePath: path.join(runtimeRoot, REMOTE_NODE_RELATIVE),
        wrapperPath,
        entryPath,
        nodePtyRoot: path.join(runtimeRoot, REMOTE_NODE_PTY_RELATIVE),
        nativeModule: path.join(
          runtimeRoot,
          REMOTE_NODE_PTY_RELATIVE,
          "build",
          "Release",
          "pty.node",
        ),
        archiveSha256: "skipped-non-linux",
      };
    }
    throw new Error(
      "installLinuxRemoteRuntime native stage requires Linux x64 (set skipNativeRebuild for layout-only tests)",
    );
  }

  const stagedNode = await stageOfficialNodeBinary({
    repoRoot,
    runtimeRoot,
    version: nodeVersion,
    cacheRoot: input.cacheRoot,
    download: input.download,
  });

  if (input.skipNativeRebuild === true) {
    return {
      ok: true,
      nodeVersion,
      nodePath: stagedNode.nodePath,
      wrapperPath,
      entryPath,
      nodePtyRoot: path.join(runtimeRoot, REMOTE_NODE_PTY_RELATIVE),
      nativeModule: path.join(
        runtimeRoot,
        REMOTE_NODE_PTY_RELATIVE,
        "build",
        "Release",
        "pty.node",
      ),
      archiveSha256: stagedNode.archiveSha256,
    };
  }

  const pty = await stageNodePtyForBundledNode({
    repoRoot,
    runtimeRoot,
    bundledNode: stagedNode.nodePath,
    nodeVersion,
  });

  return {
    ok: true,
    nodeVersion,
    nodePath: stagedNode.nodePath,
    wrapperPath,
    entryPath,
    nodePtyRoot: pty.nodePtyRoot,
    nativeModule: pty.nativeModule,
    archiveSha256: stagedNode.archiveSha256,
  };
};

/** Required relative paths the archive audit must see for displayless remote. */
export const LINUX_REMOTE_RUNTIME_REQUIRED_FILES = [
  REMOTE_NODE_RELATIVE,
  REMOTE_WRAPPER_RELATIVE,
  REMOTE_ENTRY_RELATIVE,
] as const;

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const args = process.argv.slice(2);
  let runtimeRoot: string | undefined;
  let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let cacheRoot: string | undefined;
  let entrySource: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--runtime" && value !== undefined) {
      runtimeRoot = value;
      index += 1;
    } else if (flag === "--repo" && value !== undefined) {
      repoRoot = path.resolve(value);
      index += 1;
    } else if (flag === "--cache" && value !== undefined) {
      cacheRoot = value;
      index += 1;
    } else if (flag === "--entry" && value !== undefined) {
      entrySource = value;
      index += 1;
    } else {
      throw new Error(
        "usage: build-linux-remote-runtime.ts --runtime <linux-unpacked> [--repo <root>] [--cache <dir>] [--entry <relative>]",
      );
    }
  }
  if (runtimeRoot === undefined) {
    throw new Error(
      "usage: build-linux-remote-runtime.ts --runtime <linux-unpacked> [--repo <root>] [--cache <dir>] [--entry <relative>]",
    );
  }
  // mkdtemp keeps the import tree green when accidentally imported without side effects.
  void mkdtemp;
  void access;
  void tmpdir;
  const receipt = await installLinuxRemoteRuntime({
    repoRoot,
    runtimeRoot,
    cacheRoot,
    entrySourceRelative: entrySource,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
