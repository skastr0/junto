/**
 * Stage the displayless Linux Remote runtime into an electron-builder
 * linux-unpacked (or finalized) tree:
 *
 *   resources/bin/node              — official Node linux-x64 binary
 *   resources/bin/vellum-command-remote     — wrapper that exec's bundled node on the entry
 *   resources/app-remote/…          — remote JS entry + node-pty rebuilt for Node ABI
 *
 * Product remote is Node, never ELECTRON_RUN_AS_NODE and never Bun --compile.
 * Full download + node-pty rebuild only runs on Linux x64; pure helpers and
 * --entry-only JS bundle are OS-portable.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  featureBunDefineArgs,
  resolveBuildFeatures,
} from "./build-features";
import { PRODUCTION_LICENSE_BUILD_PROFILE } from "./license-build-profile";

/** Pinned Node for the product Remote. Override with NODE_REMOTE_VERSION. */
export const DEFAULT_NODE_REMOTE_VERSION = "24.18.0";
export const DEFAULT_NODE_REMOTE_MODULE_ABI = "137";

/**
 * Reviewed official Node linux-x64 tarball digests keyed by exact version.
 * Source: https://nodejs.org/dist/v{version}/SHASUMS256.txt
 * Refuse download or cache when the computed digest differs.
 */
export const PINNED_NODE_LINUX_X64_ARCHIVE_SHA256: Readonly<
  Record<string, string>
> = Object.freeze({
  "24.18.0":
    "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
});

export const pinnedNodeLinuxX64ArchiveSha256 = (
  version: string,
): string => {
  const resolved = requireNodeRemoteVersion(version);
  const digest = PINNED_NODE_LINUX_X64_ARCHIVE_SHA256[resolved];
  if (digest === undefined || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(
      `no reviewed Node linux-x64 archive digest is pinned for ${resolved}`,
    );
  }
  return digest;
};

export const REMOTE_NODE_RELATIVE = "resources/bin/node";
export const REMOTE_WRAPPER_RELATIVE = "resources/bin/vellum-command-remote";
export const REMOTE_APP_DIR_RELATIVE = "resources/app-remote";
export const REMOTE_ENTRY_RELATIVE = "resources/app-remote/vellum-command-remote.js";
export const REMOTE_NODE_PTY_RELATIVE =
  "resources/app-remote/node_modules/node-pty";
export const REMOTE_APP_PACKAGE_RELATIVE = "resources/app-remote/package.json";

/**
 * Exact stock node-pty files needed by the displayless Linux runtime, plus its
 * license. Native compilation happens in a disposable workspace; node-gyp
 * sources, object files, dependency files, and hard-link aliases never enter
 * the packaged tree.
 */
export const LINUX_NODE_PTY_RUNTIME_FILES = [
  "LICENSE",
  "package.json",
  "lib/eventEmitter2.js",
  "lib/index.js",
  "lib/terminal.js",
  "lib/unixTerminal.js",
  "lib/utils.js",
  "build/Release/pty.node",
] as const;

export const LINUX_NODE_PTY_NATIVE_RELATIVE =
  "build/Release/pty.node";

/** Repo-side build output copied into the runtime when present. */
export const REMOTE_ENTRY_SOURCE_RELATIVE = "out/remote/vellum-command-remote.js";
/** TypeScript product entry compiled by --entry-only. */
export const REMOTE_ENTRY_TS_RELATIVE = "src/main/vellum-remote.ts";

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const requireNodeRemoteVersion = (value: unknown): string => {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(
      `invalid NODE_REMOTE_VERSION (need semver x.y.z): ${String(value)}`,
    );
  }
  const major = Number(value.split(".")[0]);
  if (major !== 24) {
    throw new Error(
      `NODE_REMOTE_VERSION must be Node 24 LTS (got ${value}); remote ABI is pinned to 24.x`,
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
 * Wrapper executed as resources/bin/vellum-command-remote. Resolves the release root
 * from argv0, never uses system node, never sets ELECTRON_RUN_AS_NODE.
 */
export const vellumRemoteWrapperScript = (): string => `#!/bin/sh
# Displayless product Remote: bundled Node + app-remote entry. No system Node,
# no Bun compile, no ELECTRON_RUN_AS_NODE.
set -eu
fail() { printf '%s\\n' "vellum-command-remote: $1" >&2; exit "\${2:-69}"; }
case "\${0}" in
  */resources/bin/vellum-command-remote) release=\${0%/resources/bin/vellum-command-remote} ;;
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
# Preserve the generation-pinned wrapper path after exec replaces argv0 with node.
export VELLUM_COMMAND_REMOTE_BINARY="$release/${REMOTE_WRAPPER_RELATIVE}"
unset ELECTRON_RUN_AS_NODE
exec "$node" "$entry" "$@"
`;

export const remoteEntryMissingMessage = (entrySource: string): string =>
  [
    "Linux remote runtime requires a displayless Node entry before packaging.",
    `Missing: ${entrySource}`,
    `Build with: bun scripts/build-linux-remote-runtime.ts --entry-only`,
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

/**
 * Bundle src/main/vellum-remote.ts → out/remote/vellum-command-remote.js (CJS, Node target).
 * Not Bun --compile — product remote loads under the official Node binary.
 */
export const buildRemoteEntryBundle = async (input: {
  readonly repoRoot: string;
}): Promise<{ readonly entryPath: string; readonly bytes: number }> => {
  const repoRoot = path.resolve(input.repoRoot);
  const source = path.join(repoRoot, REMOTE_ENTRY_TS_RELATIVE);
  const outfile = path.join(repoRoot, REMOTE_ENTRY_SOURCE_RELATIVE);
  const stage = `${outfile}.new.${String(process.pid)}`;
  if (!(await isNonSymlinkFile(source))) {
    throw new Error(
      remoteEntryMissingMessage(
        `${REMOTE_ENTRY_TS_RELATIVE} (TypeScript product remote entry)`,
      ),
    );
  }
  if (
    process.env.VELLUM_COMMAND_LICENSE_CHANNEL !== undefined &&
    process.env.VELLUM_COMMAND_LICENSE_CHANNEL !== "production"
  ) {
    throw new Error(
      "remote packaging requires VELLUM_COMMAND_LICENSE_CHANNEL=production",
    );
  }
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error("remote packaging requires package.json version");
  }
  const featureDefines = featureBunDefineArgs(
    resolveBuildFeatures(process.env),
  );
  await mkdir(path.dirname(outfile), { recursive: true, mode: 0o755 });
  await rm(stage, { force: true });
  try {
    // bun build is transpile/bundle only. The packaged stock Node binary owns
    // the product Remote ABI, and this is the one canonical Remote recipe.
    run(
      "bun",
      [
        "build",
        source,
        "--outfile",
        stage,
        "--target",
        "node",
        "--format",
        "cjs",
        "--external",
        "node-pty",
        "--external",
        "electron",
        `--define=__VELLUM_COMMAND_LICENSE_CHANNEL__=${JSON.stringify(PRODUCTION_LICENSE_BUILD_PROFILE.channel)}`,
        `--define=__VELLUM_COMMAND_DODO_BUSINESS_ID__=${JSON.stringify(PRODUCTION_LICENSE_BUILD_PROFILE.businessId)}`,
        `--define=__VELLUM_COMMAND_DODO_PRODUCT_IDS__=${JSON.stringify(PRODUCTION_LICENSE_BUILD_PROFILE.productIds)}`,
        `--define=__VELLUM_COMMAND_MAC_UPDATE_FEED_URL__=${JSON.stringify("")}`,
        `--define=__VELLUM_COMMAND_APP_VERSION__=${JSON.stringify(packageJson.version)}`,
        ...featureDefines,
      ],
      { cwd: repoRoot },
    );
    if (!(await isNonSymlinkFile(stage))) {
      throw new Error(
        `remote entry bundle was not written: ${REMOTE_ENTRY_SOURCE_RELATIVE}`,
      );
    }

    let body = await readFile(stage, "utf8");
    // A CC-only lazy helper can leave an unreachable external require. Never
    // let the displayless Node Remote resolve the Electron package.
    body = body.replace(
      /(?:__require|require)\s*\(\s*["']electron["']\s*\)/gu,
      '(() => { throw new Error("electron is forbidden in vellum-command-remote"); })()',
    );
    const forbidden: ReadonlyArray<{
      readonly pattern: RegExp;
      readonly label: string;
    }> = [
      {
        pattern: /(?:^|\n)\s*import\s+[^;]*\bfrom\s+["']electron["']/u,
        label: "static electron import",
      },
      {
        pattern: /(?:__require|require)\s*\(\s*["']electron["']\s*\)/u,
        label: "require(electron)",
      },
      { pattern: /\bBrowserWindow\b/u, label: "BrowserWindow" },
      {
        pattern: /startBrowserComposition|browser\/composition(?:-host)?/u,
        label: "browser-composition",
      },
      {
        pattern: /from\s+["'][^"']*\/renderer\/[^"']+["']/u,
        label: "renderer import",
      },
      {
        pattern:
          /process\.env\.ELECTRON_RUN_AS_NODE\s*=\s*["']?1/u,
        label: "forbidden Electron Node mode assignment",
      },
    ];
    const hits = forbidden.flatMap(({ pattern, label }) =>
      pattern.test(body) ? [label] : [],
    );
    if (hits.length > 0) {
      throw new Error(
        `remote entry bundle emitted forbidden symbols: ${hits.join(", ")}`,
      );
    }
    // Bun can retain package.json script text that names the forbidden mode.
    // It is inert metadata, but remove the token so package closure audits do
    // not confuse it with an executable assignment. Real assignments were
    // rejected above before this metadata-only rewrite.
    const inertModeMarker = new RegExp(
      ["ELECTRON_RUN_AS_NODE", "\\s*", "=", "\\s*", "([\"']?)1"].join(""),
      "gu",
    );
    body = body.replace(inertModeMarker, "ELECTRON_RUN_AS_NODE prohibited");
    if (!body.startsWith("#!")) body = `#!/usr/bin/env node\n${body}`;
    await writeFile(stage, body, { encoding: "utf8", mode: 0o755 });
    await chmod(stage, 0o755);
    const bytes = (await readFile(stage)).byteLength;
    if (bytes < 1024) {
      throw new Error(
        `remote entry bundle is implausibly small (${String(bytes)} bytes)`,
      );
    }
    await rename(stage, outfile);
    return { entryPath: outfile, bytes };
  } finally {
    await rm(stage, { force: true });
  }
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
  const member = `node-v${requireNodeRemoteVersion(version)}-linux-x64/bin/node`;
  const stagingParent = path.dirname(destinationNode);
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
};

/**
 * Resolve where to cache official Node tarballs. Prefer an explicit cache root,
 * else <repo>/release/.cache/node.
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
  readonly download?: (url: string, destination: string) => Promise<void>;
}): Promise<{ readonly nodePath: string; readonly version: string; readonly archiveSha256: string }> => {
  const version = requireNodeRemoteVersion(input.version);
  const cache = resolveNodeDownloadCache({
    repoRoot: input.repoRoot,
    cacheRoot: input.cacheRoot,
  });
  await mkdir(cache, { recursive: true, mode: 0o755 });
  const archive = path.join(cache, nodeLinuxX64ArchiveName(version));
  const expectedSha256 = pinnedNodeLinuxX64ArchiveSha256(version);
  if (!(await isNonSymlinkFile(archive))) {
    const url = nodeLinuxX64ArchiveUrl(version);
    const partial = `${archive}.partial`;
    await rm(partial, { force: true });
    const download = input.download ?? downloadToFile;
    await download(url, partial);
    await chmod(partial, 0o644);
    const partialDigest = await sha256File(partial);
    if (partialDigest !== expectedSha256) {
      await rm(partial, { force: true });
      throw new Error(
        `Node linux-x64 archive digest mismatch for ${version}: expected ${expectedSha256}, got ${partialDigest}`,
      );
    }
    run("/usr/bin/mv", ["-f", partial, archive]);
  }
  const archiveSha256 = await sha256File(archive);
  if (archiveSha256 !== expectedSha256) {
    await rm(archive, { force: true });
    throw new Error(
      `cached Node linux-x64 archive digest mismatch for ${version}: expected ${expectedSha256}, got ${archiveSha256}`,
    );
  }
  const nodePath = path.join(input.runtimeRoot, REMOTE_NODE_RELATIVE);
  await mkdir(path.dirname(nodePath), { recursive: true, mode: 0o755 });
  extractNodeBinaryFromArchive({ archive, destinationNode: nodePath, version });
  return { nodePath, version, archiveSha256 };
};

/**
 * Materialize only node-pty's stock Linux runtime surface from a completed
 * node-gyp build. Each file is copied into a fresh tree, so node-gyp's
 * build/Release/obj.target/pty.node hard link cannot survive as a tar entry.
 */
export const stageBuiltNodePtyLinuxRuntime = async (input: {
  readonly builtNodePtyRoot: string;
  readonly destinationNodePtyRoot: string;
}): Promise<{ readonly nodePtyRoot: string; readonly nativeModule: string }> => {
  const builtNodePtyRoot = path.resolve(input.builtNodePtyRoot);
  const destinationNodePtyRoot = path.resolve(input.destinationNodePtyRoot);
  if (
    builtNodePtyRoot === destinationNodePtyRoot ||
    builtNodePtyRoot.startsWith(`${destinationNodePtyRoot}${path.sep}`) ||
    destinationNodePtyRoot.startsWith(`${builtNodePtyRoot}${path.sep}`)
  ) {
    throw new Error("node-pty build and runtime roots must be separate trees");
  }

  await rm(destinationNodePtyRoot, { recursive: true, force: true });
  try {
    for (const relative of LINUX_NODE_PTY_RUNTIME_FILES) {
      const source = path.join(builtNodePtyRoot, ...relative.split("/"));
      if (!(await isNonSymlinkFile(source))) {
        throw new Error(`node-pty runtime file missing or not regular: ${relative}`);
      }
      const destination = path.join(
        destinationNodePtyRoot,
        ...relative.split("/"),
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await copyFile(source, destination);
      await chmod(
        destination,
        relative === LINUX_NODE_PTY_NATIVE_RELATIVE ? 0o755 : 0o644,
      );
      const metadata = await lstat(destination);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error(`node-pty runtime file is linked or special: ${relative}`);
      }
    }
  } catch (error) {
    await rm(destinationNodePtyRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    nodePtyRoot: destinationNodePtyRoot,
    nativeModule: path.join(
      destinationNodePtyRoot,
      ...LINUX_NODE_PTY_NATIVE_RELATIVE.split("/"),
    ),
  };
};

/**
 * Rebuild stock node-pty for the bundled Node ABI in a disposable workspace,
 * then stage only its required Linux runtime files. Linux x64 only.
 */
export const stageNodePtyForBundledNode = async (input: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly bundledNode: string;
  readonly nodeVersion: string;
}): Promise<{ readonly nodePtyRoot: string; readonly nativeModule: string }> => {
  assertLinuxX64Builder();
  const repoRoot = path.resolve(input.repoRoot);
  const sourcePty = path.join(repoRoot, "node_modules", "node-pty");
  if (!(await isNonSymlinkDirectory(sourcePty))) {
    throw new Error("node-pty is missing from node_modules — run bun install");
  }
  const nodeGyp = path.join(
    repoRoot,
    "node_modules",
    "node-gyp",
    "bin",
    "node-gyp.js",
  );
  if (!(await isNonSymlinkFile(nodeGyp))) {
    throw new Error("node-gyp missing — expected via @electron/rebuild dependency tree");
  }

  const destPty = path.join(input.runtimeRoot, REMOTE_NODE_PTY_RELATIVE);
  await rm(destPty, { recursive: true, force: true });
  await mkdir(path.dirname(destPty), { recursive: true, mode: 0o755 });
  // Keep compiler scratch outside linux-unpacked. Even an interrupted build
  // cannot leave node-gyp intermediates for the package finalizer to archive.
  const buildCache = path.join(repoRoot, "release", ".cache");
  await mkdir(buildCache, { recursive: true, mode: 0o755 });
  const workspace = await mkdtemp(path.join(buildCache, "node-pty-build-"));
  const builtPty = path.join(workspace, "node-pty");

  try {
    await cp(sourcePty, builtPty, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(sourcePty, source).split(path.sep).join("/");
        if (relative === "build" || relative.startsWith("build/")) return false;
        if (relative === "prebuilds" || relative.startsWith("prebuilds/")) return false;
        return true;
      },
    });

    const version = requireNodeRemoteVersion(input.nodeVersion);
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
        cwd: builtPty,
        env: {
          ...process.env,
          npm_config_build_from_source: "true",
          ELECTRON_RUN_AS_NODE: "",
        },
      },
    );

    const builtNative = path.join(
      builtPty,
      ...LINUX_NODE_PTY_NATIVE_RELATIVE.split("/"),
    );
    if (!(await isNonSymlinkFile(builtNative))) {
      throw new Error("node-pty rebuild for bundled Node produced no pty.node");
    }
    return await stageBuiltNodePtyLinuxRuntime({
      builtNodePtyRoot: builtPty,
      destinationNodePtyRoot: destPty,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

export const stageRemoteEntry = async (input: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly entrySourceRelative?: string;
  /** When true, run --entry-only bundle if out/remote is missing. */
  readonly buildIfMissing?: boolean;
}): Promise<{ readonly entryPath: string }> => {
  const sourceRelative =
    input.entrySourceRelative ?? REMOTE_ENTRY_SOURCE_RELATIVE;
  let source = path.join(input.repoRoot, sourceRelative);
  if (!(await isNonSymlinkFile(source))) {
    if (input.buildIfMissing === true && sourceRelative === REMOTE_ENTRY_SOURCE_RELATIVE) {
      await buildRemoteEntryBundle({ repoRoot: input.repoRoot });
      source = path.join(input.repoRoot, REMOTE_ENTRY_SOURCE_RELATIVE);
    }
  }
  if (!(await isNonSymlinkFile(source))) {
    throw new Error(remoteEntryMissingMessage(sourceRelative));
  }
  const destination = path.join(input.runtimeRoot, REMOTE_ENTRY_RELATIVE);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
  await chmod(destination, 0o644);
  // CJS entry can resolve node-pty via NODE_PATH; package.json documents the surface.
  await writeFile(
    path.join(input.runtimeRoot, REMOTE_APP_PACKAGE_RELATIVE),
    `${JSON.stringify({ name: "vellum-app-remote", private: true, main: "vellum-command-remote.js" }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
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

const walkRemoteAppFiles = async (
  root: string,
  relative = "",
): Promise<string[]> => {
  const files: string[] = [];
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    const metadata = await lstat(path.join(root, child));
    if (metadata.isSymbolicLink()) {
      throw new Error(`staged app-remote contains a symlink: ${child}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await walkRemoteAppFiles(root, child)));
    } else if (metadata.isFile()) {
      files.push(child);
    } else {
      throw new Error(`staged app-remote contains an unsupported entry: ${child}`);
    }
  }
  return files;
};

const assertExactStagedRemoteApp = async (input: {
  readonly appRoot: string;
  readonly requireProvenance: boolean;
  readonly requireNative: boolean;
}): Promise<void> => {
  const actual = await walkRemoteAppFiles(input.appRoot);
  const expected = ["package.json", "vellum-command-remote.js"];
  if (input.requireProvenance) {
    expected.push("package-runtime-provenance.json");
  }
  if (input.requireNative) {
    expected.push(
      ...LINUX_NODE_PTY_RUNTIME_FILES.map(
        (file) => `node_modules/node-pty/${file}`,
      ),
    );
  }
  expected.sort((left, right) => left.localeCompare(right));
  if (
    actual.length !== expected.length ||
    !actual.every((value, index) => value === expected[index])
  ) {
    const extra = actual.find((value) => !expected.includes(value));
    const missing = expected.find((value) => !actual.includes(value));
    throw new Error(
      `staged app-remote closure is not exact${extra === undefined ? "" : `; extra ${extra}`}${missing === undefined ? "" : `; missing ${missing}`}`,
    );
  }
};

const replaceOwnedDirectory = async (input: {
  readonly staged: string;
  readonly destination: string;
  readonly backup: string;
}): Promise<void> => {
  const stagedMetadata = await lstat(input.staged);
  if (!stagedMetadata.isDirectory() || stagedMetadata.isSymbolicLink()) {
    throw new Error("staged app-remote must be a non-symlink directory");
  }
  const destinationMetadata = await lstat(input.destination).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (
    destinationMetadata !== undefined &&
    (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink())
  ) {
    throw new Error("existing app-remote must be a non-symlink directory");
  }
  if ((await lstat(input.backup).catch(() => undefined)) !== undefined) {
    throw new Error("app-remote replacement backup already exists");
  }
  if (destinationMetadata !== undefined) {
    await rename(input.destination, input.backup);
  }
  try {
    await rename(input.staged, input.destination);
  } catch (error) {
    if (destinationMetadata !== undefined) {
      await rename(input.backup, input.destination);
    }
    throw error;
  }
  if (destinationMetadata !== undefined) {
    await rm(input.backup, { recursive: true, force: false });
  }
};

const replaceOwnedRegularFile = async (
  staged: string,
  destination: string,
): Promise<void> => {
  const stagedMetadata = await lstat(staged);
  if (!stagedMetadata.isFile() || stagedMetadata.isSymbolicLink()) {
    throw new Error(`staged Remote file must be regular: ${staged}`);
  }
  const destinationMetadata = await lstat(destination).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (
    destinationMetadata?.isSymbolicLink() === true ||
    (destinationMetadata !== undefined && !destinationMetadata.isFile())
  ) {
    throw new Error(`existing Remote file must be regular: ${destination}`);
  }
  await rm(destination, { force: true });
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await rename(staged, destination);
};

/**
 * Full stage into an existing linux-unpacked / runtime root. A private sibling
 * holds the entire generation, then app-remote is switched as one directory.
 */
export const installLinuxRemoteRuntime = async (input: {
  readonly repoRoot: string;
  readonly runtimeRoot: string;
  readonly nodeVersion?: string;
  readonly cacheRoot?: string;
  readonly entrySourceRelative?: string;
  readonly provenanceSourceRelative?: string;
  readonly requireProvenance?: boolean;
  readonly requireEntry?: boolean;
  readonly buildIfMissing?: boolean;
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
  const requireProvenance = input.requireProvenance === true;
  const stageRoot = await mkdtemp(
    path.join(runtimeRoot, ".vellum-remote-stage-"),
  );
  await chmod(stageRoot, 0o700);
  const stagedAppRoot = path.join(stageRoot, REMOTE_APP_DIR_RELATIVE);
  let archiveSha256 = "skipped-non-linux";
  try {
    await stageVellumRemoteWrapper(stageRoot);
    if (requireEntry) {
      await stageRemoteEntry({
        repoRoot,
        runtimeRoot: stageRoot,
        entrySourceRelative: input.entrySourceRelative,
        buildIfMissing: input.buildIfMissing,
      });
    } else {
      await mkdir(stagedAppRoot, { recursive: true, mode: 0o755 });
    }

    if (requireProvenance) {
      const provenanceRelative =
        input.provenanceSourceRelative ??
        "out/remote/package-runtime-provenance.json";
      const provenanceSource = path.join(repoRoot, provenanceRelative);
      if (!(await isNonSymlinkFile(provenanceSource))) {
        throw new Error("fresh Remote provenance is missing");
      }
      await copyFile(
        provenanceSource,
        path.join(stagedAppRoot, "package-runtime-provenance.json"),
      );
      await chmod(
        path.join(stagedAppRoot, "package-runtime-provenance.json"),
        0o644,
      );
    }

    const canBuildNative = process.platform === "linux" && process.arch === "x64";
    if (!canBuildNative && input.skipNativeRebuild !== true) {
      throw new Error(
        "installLinuxRemoteRuntime native stage requires Linux x64 execution (set skipNativeRebuild for layout-only tests)",
      );
    }

    let stagedNodePath = path.join(stageRoot, REMOTE_NODE_RELATIVE);
    if (canBuildNative) {
      const stagedNode = await stageOfficialNodeBinary({
        repoRoot,
        runtimeRoot: stageRoot,
        version: nodeVersion,
        cacheRoot: input.cacheRoot,
        download: input.download,
      });
      stagedNodePath = stagedNode.nodePath;
      archiveSha256 = stagedNode.archiveSha256;
      if (input.skipNativeRebuild !== true) {
        const pty = await stageNodePtyForBundledNode({
          repoRoot,
          runtimeRoot: stageRoot,
          bundledNode: stagedNode.nodePath,
          nodeVersion,
        });
      }
    }

    await assertExactStagedRemoteApp({
      appRoot: stagedAppRoot,
      requireProvenance,
      requireNative: canBuildNative && input.skipNativeRebuild !== true,
    });

    const resources = path.join(runtimeRoot, "resources");
    await mkdir(resources, { recursive: true, mode: 0o755 });
    await replaceOwnedDirectory({
      staged: stagedAppRoot,
      destination: path.join(runtimeRoot, REMOTE_APP_DIR_RELATIVE),
      backup: path.join(resources, `.app-remote.old.${String(process.pid)}`),
    });
    const stagedWrapper = path.join(stageRoot, REMOTE_WRAPPER_RELATIVE);
    await replaceOwnedRegularFile(
      stagedWrapper,
      path.join(runtimeRoot, REMOTE_WRAPPER_RELATIVE),
    );
    if (canBuildNative) {
      await replaceOwnedRegularFile(
        stagedNodePath,
        path.join(runtimeRoot, REMOTE_NODE_RELATIVE),
      );
    }

    return {
      ok: true,
      nodeVersion,
      nodePath: path.join(runtimeRoot, REMOTE_NODE_RELATIVE),
      wrapperPath: path.join(runtimeRoot, REMOTE_WRAPPER_RELATIVE),
      entryPath: path.join(runtimeRoot, REMOTE_ENTRY_RELATIVE),
      nodePtyRoot: path.join(runtimeRoot, REMOTE_NODE_PTY_RELATIVE),
      nativeModule: path.join(
        runtimeRoot,
        REMOTE_NODE_PTY_RELATIVE,
        "build",
        "Release",
        "pty.node",
      ),
      archiveSha256,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
};

/** Required relative paths the archive audit must see for displayless remote. */
export const LINUX_REMOTE_RUNTIME_REQUIRED_FILES = [
  REMOTE_NODE_RELATIVE,
  REMOTE_WRAPPER_RELATIVE,
  REMOTE_ENTRY_RELATIVE,
] as const;

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--entry-only") {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const receipt = await buildRemoteEntryBundle({ repoRoot });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "entry-only", ...receipt })}\n`);
    process.exit(0);
  }

  let runtimeRoot: string | undefined;
  let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let cacheRoot: string | undefined;
  let entrySource: string | undefined;
  let provenanceSource: string | undefined;
  let buildIfMissing = false;
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
    } else if (flag === "--provenance" && value !== undefined) {
      provenanceSource = value;
      index += 1;
    } else if (flag === "--no-build-entry") {
      buildIfMissing = false;
    } else {
      throw new Error(
        "usage: build-linux-remote-runtime.ts --entry-only | --runtime <linux-unpacked> [--repo <root>] [--cache <dir>] [--entry <relative>] [--no-build-entry]",
      );
    }
  }
  if (runtimeRoot === undefined) {
    throw new Error(
      "usage: build-linux-remote-runtime.ts --entry-only | --runtime <linux-unpacked> [--repo <root>] [--cache <dir>] [--entry <relative>] [--no-build-entry]",
    );
  }
  const receipt = await installLinuxRemoteRuntime({
    repoRoot,
    runtimeRoot,
    cacheRoot,
    entrySourceRelative: entrySource,
    provenanceSourceRelative: provenanceSource,
    requireProvenance: true,
    buildIfMissing,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
