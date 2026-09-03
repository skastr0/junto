/**
 * Displayless Linux Remote product contract.
 *
 * Packaging ships bundled Node + resources/bin/vellum-command-remote + app-remote
 * entry, rebuilds node-pty for that Node ABI, and never uses
 * ELECTRON_RUN_AS_NODE or Bun --compile for the product remote.
 */
import {
  link,
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
import { describe, expect, it } from "vitest";
import { LINUX_RUNTIME_REQUIRED_FILES } from "../scripts/audit-linux-package";
import {
  DEFAULT_NODE_REMOTE_MODULE_ABI,
  DEFAULT_NODE_REMOTE_VERSION,
  LINUX_NODE_PTY_NATIVE_RELATIVE,
  LINUX_NODE_PTY_RUNTIME_FILES,
  PINNED_NODE_LINUX_X64_ARCHIVE_SHA256,
  pinnedNodeLinuxX64ArchiveSha256,
  LINUX_REMOTE_RUNTIME_REQUIRED_FILES,
  REMOTE_ENTRY_RELATIVE,
  REMOTE_ENTRY_SOURCE_RELATIVE,
  REMOTE_NODE_RELATIVE,
  REMOTE_WRAPPER_RELATIVE,
  installLinuxRemoteRuntime,
  nodeLinuxX64ArchiveName,
  nodeLinuxX64ArchiveUrl,
  remoteEntryMissingMessage,
  requireNodeRemoteVersion,
  resolveNodeRemoteVersion,
  stageBuiltNodePtyLinuxRuntime,
  stageRemoteEntry,
  stageVellumRemoteWrapper,
  vellumRemoteWrapperScript,
} from "../scripts/build-linux-remote-runtime";

const readRepo = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

type InspectedTreeEntry = {
  readonly relative: string;
  readonly kind: "directory" | "file" | "other";
  readonly links: number;
};

const inspectTree = async (
  root: string,
  relative = "",
): Promise<ReadonlyArray<InspectedTreeEntry>> => {
  const entries: Array<InspectedTreeEntry> = [];
  for (const name of await readdir(path.join(root, relative))) {
    const childRelative = path.join(relative, name);
    const metadata = await lstat(path.join(root, childRelative));
    const kind = metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : "other";
    entries.push({
      relative: childRelative.split(path.sep).join("/"),
      kind,
      links: metadata.nlink,
    });
    if (kind === "directory") {
      entries.push(...(await inspectTree(root, childRelative)));
    }
  }
  return entries;
};

describe("Linux remote displayless packaging helpers", () => {
  it("pins stock Node 26.5.1 and names the official linux-x64 archive", () => {
    expect(DEFAULT_NODE_REMOTE_VERSION).toBe("26.5.1");
    expect(DEFAULT_NODE_REMOTE_MODULE_ABI).toBe("147");
    expect(requireNodeRemoteVersion("26.5.1")).toBe("26.5.1");
    expect(() => requireNodeRemoteVersion("25.5.1")).toThrow(/26/u);
    expect(() => requireNodeRemoteVersion("27.5.1")).toThrow(/26/u);
    expect(() => requireNodeRemoteVersion("not-a-version")).toThrow(/semver/u);
    expect(nodeLinuxX64ArchiveName("26.5.1")).toBe(
      "node-v26.5.1-linux-x64.tar.gz",
    );
    expect(nodeLinuxX64ArchiveUrl("26.5.1")).toBe(
      "https://nodejs.org/dist/v26.5.1/node-v26.5.1-linux-x64.tar.gz",
    );
    expect(resolveNodeRemoteVersion({})).toBe(DEFAULT_NODE_REMOTE_VERSION);
    expect(resolveNodeRemoteVersion({ NODE_REMOTE_VERSION: "26.4.1" })).toBe(
      "26.4.1",
    );
  });

  it("refuses Node archives without the reviewed linux-x64 digest pin", () => {
    expect(pinnedNodeLinuxX64ArchiveSha256("26.5.1")).toBe(
      PINNED_NODE_LINUX_X64_ARCHIVE_SHA256["26.5.1"],
    );
    expect(pinnedNodeLinuxX64ArchiveSha256("26.5.1")).toBe(
      "2b07f09c218d473a26442bff5a90151f53f7b7c0a23bad244eda2c26303a2ba7",
    );
    expect(() => pinnedNodeLinuxX64ArchiveSha256("26.4.1")).toThrow(
      /no reviewed Node linux-x64 archive digest/u,
    );
  });

  it("stages a link-free node-pty runtime from node-gyp hard-linked output", async () => {
    expect(LINUX_NODE_PTY_NATIVE_RELATIVE).toBe("build/Release/pty.node");
    expect(LINUX_NODE_PTY_RUNTIME_FILES).toEqual([
      "LICENSE",
      "package.json",
      "lib/eventEmitter2.js",
      "lib/index.js",
      "lib/terminal.js",
      "lib/unixTerminal.js",
      "lib/utils.js",
      "build/Release/pty.node",
    ]);
    const root = await mkdtemp(path.join(tmpdir(), "vellum-command-node-pty-"));
    try {
      const built = path.join(root, "built-node-pty");
      const staged = path.join(root, "staged-node-pty");
      for (const relative of LINUX_NODE_PTY_RUNTIME_FILES) {
        const source = path.join(built, ...relative.split("/"));
        await mkdir(path.dirname(source), { recursive: true });
        await writeFile(source, `stock node-pty: ${relative}\n`);
      }

      const builtNative = path.join(
        built,
        ...LINUX_NODE_PTY_NATIVE_RELATIVE.split("/"),
      );
      const objectAlias = path.join(
        built,
        "build",
        "Release",
        "obj.target",
        "pty.node",
      );
      await mkdir(path.dirname(objectAlias), { recursive: true });
      await link(builtNative, objectAlias);
      await writeFile(path.join(built, "binding.gyp"), "build input\n");
      await writeFile(
        path.join(built, "lib", "unixTerminal.test.js"),
        "test output\n",
      );
      expect((await lstat(builtNative)).nlink).toBe(2);

      const receipt = await stageBuiltNodePtyLinuxRuntime({
        builtNodePtyRoot: built,
        destinationNodePtyRoot: staged,
      });
      expect(receipt.nodePtyRoot).toBe(staged);
      expect(receipt.nativeModule).toBe(
        path.join(staged, ...LINUX_NODE_PTY_NATIVE_RELATIVE.split("/")),
      );

      const stagedEntries = await inspectTree(staged);
      expect(stagedEntries.some((entry) => entry.kind === "other")).toBe(false);
      expect(
        stagedEntries
          .filter((entry) => entry.kind === "file")
          .map((entry) => entry.relative)
          .sort(),
      ).toEqual([...LINUX_NODE_PTY_RUNTIME_FILES].sort());
      for (const entry of stagedEntries) {
        if (entry.kind === "file") expect(entry.links).toBe(1);
      }
      expect(
        stagedEntries.some((entry) => entry.relative.includes("obj.target")),
      ).toBe(false);
      expect(stagedEntries.some((entry) => entry.relative === "binding.gyp")).toBe(
        false,
      );
      expect(
        stagedEntries.some(
          (entry) => entry.relative === "lib/unixTerminal.test.js",
        ),
      ).toBe(false);

      for (const relative of LINUX_NODE_PTY_RUNTIME_FILES) {
        await expect(
          readFile(path.join(staged, ...relative.split("/"))),
        ).resolves.toEqual(
          await readFile(path.join(built, ...relative.split("/"))),
        );
      }
      const stagedNativeMetadata = await lstat(receipt.nativeModule);
      expect(stagedNativeMetadata.nlink).toBe(1);
      expect(stagedNativeMetadata.mode & 0o777).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wrapper execs bundled node on app-remote entry without ELECTRON_RUN_AS_NODE", () => {
    const script = vellumRemoteWrapperScript();
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("resources/bin/vellum-command-remote");
    expect(script).toContain(REMOTE_NODE_RELATIVE);
    expect(script).toContain(REMOTE_ENTRY_RELATIVE);
    expect(script).toContain('exec "$node" "$entry" "$@"');
    expect(script).toContain("unset ELECTRON_RUN_AS_NODE");
    expect(script).not.toMatch(/ELECTRON_RUN_AS_NODE=1|bun |Xvfb|xauth|mcookie/u);
    expect(script).not.toMatch(/\/usr\/bin\/node|command -v node|type node/u);
  });

  it("fails closed with a clear message when the remote JS entry is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-command-remote-entry-"));
    try {
      const runtime = path.join(root, "runtime");
      await mkdir(runtime, { recursive: true });
      await expect(
        installLinuxRemoteRuntime({
          repoRoot: root,
          runtimeRoot: runtime,
          requireEntry: true,
          buildIfMissing: false,
          skipNativeRebuild: true,
        }),
      ).rejects.toThrow(/out\/remote\/vellum-command-remote\.js/u);
      expect(remoteEntryMissingMessage(REMOTE_ENTRY_SOURCE_RELATIVE)).toContain(
        REMOTE_ENTRY_SOURCE_RELATIVE,
      );
      expect(remoteEntryMissingMessage(REMOTE_ENTRY_SOURCE_RELATIVE)).toContain(
        "ELECTRON_RUN_AS_NODE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages wrapper + entry on any OS when native rebuild is skipped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-command-remote-layout-"));
    try {
      const runtime = path.join(root, "runtime");
      await mkdir(runtime, { recursive: true });
      await mkdir(path.join(root, "out", "remote"), { recursive: true });
      await writeFile(
        path.join(root, REMOTE_ENTRY_SOURCE_RELATIVE),
        'console.log("remote-placeholder");\n',
        { mode: 0o644 },
      );
      const { wrapperPath } = await stageVellumRemoteWrapper(runtime);
      const { entryPath } = await stageRemoteEntry({
        repoRoot: root,
        runtimeRoot: runtime,
        buildIfMissing: false,
      });
      expect(wrapperPath).toBe(path.join(runtime, REMOTE_WRAPPER_RELATIVE));
      expect(entryPath).toBe(path.join(runtime, REMOTE_ENTRY_RELATIVE));
      const wrapper = await readFile(wrapperPath, "utf8");
      expect(wrapper).toContain("unset ELECTRON_RUN_AS_NODE");
      const entry = await readFile(entryPath, "utf8");
      expect(entry).toContain("remote-placeholder");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Linux remote displayless product contracts", () => {
  it("audit requires bundled node, vellum-command-remote, and app-remote entry", () => {
    for (const required of LINUX_REMOTE_RUNTIME_REQUIRED_FILES) {
      expect(LINUX_RUNTIME_REQUIRED_FILES).toContain(required);
    }
    expect(LINUX_RUNTIME_REQUIRED_FILES).toEqual(
      expect.arrayContaining([
        "resources/bin/node",
        "resources/bin/vellum-command-remote",
        "resources/app-remote/vellum-command-remote.js",
      ]),
    );
  });

  it("package + finalize paths stage displayless remote inside the dir archive", async () => {
    const buildApp = await readRepo("scripts/build-app.sh");
    expect(buildApp).not.toContain("DEFAULT_NODE_REMOTE_VERSION");
    expect(buildApp).not.toContain("REQUIRED_NODE_VERSION");
    expect(buildApp).not.toContain("--runtime-cohort-only");

    const packageScript = await readRepo("scripts/package-app-linux.sh");
    expect(packageScript).toContain("build-linux-remote-runtime.ts");
    expect(packageScript).not.toContain("DEFAULT_NODE_REMOTE_VERSION");
    expect(packageScript).not.toContain("REQUIRED_NODE_VERSION");
    expect(packageScript).not.toContain("--runtime-cohort-only");
    expect(packageScript).not.toContain("verify-source");
    expect(packageScript).toContain("linux-unpacked");
    // Comments may name the forbidden flag; assignment/export is the product foul.
    expect(packageScript).not.toMatch(/ELECTRON_RUN_AS_NODE\s*=/u);
    expect(packageScript).not.toMatch(/\bdeb\b|dpkg/u);

    const finalize = await readRepo("scripts/finalize-linux-package.ts");
    expect(finalize).toContain('"resources/bin/node"');
    expect(finalize).toContain('"resources/bin/vellum-command-remote"');
    expect(finalize).toContain("spawn-helper");

    const buildRemote = await readRepo("scripts/build-linux-remote-runtime.ts");
    expect(buildRemote).toContain("nodejs.org/dist");
    expect(buildRemote).toContain("node-gyp");
    expect(buildRemote).toContain("npm_config_build_from_source");
    expect(buildRemote).toContain("--entry-only");
    expect(buildRemote).not.toMatch(/ELECTRON_RUN_AS_NODE\s*=\s*["']?1/u);
    expect(buildRemote).not.toMatch(/bun build --compile/u);
  });

  it("package scripts have no product .deb path", async () => {
    const packageScript = await readRepo("scripts/package-app-linux.sh");
    const pkg = JSON.parse(await readRepo("package.json")) as {
      build: { linux: { target?: unknown } };
      scripts: Record<string, string>;
    };
    expect(pkg.build.linux.target).toEqual(["dir"]);
    expect(JSON.stringify(pkg.build.linux)).not.toMatch(/"deb"/u);
    expect(packageScript).toContain("electron-builder --linux dir --x64");
    expect(packageScript).not.toMatch(/electron-builder[^\n]*\bdeb\b/u);
    for (const name of Object.keys(pkg.scripts)) {
      if (name.startsWith("app:build")) {
        expect(pkg.scripts[name] ?? "").not.toMatch(/\bdeb\b/u);
      }
    }
  });

  it("user service template is displayless and pinned to vellum-command-remote", async () => {
    const unit = await readRepo("build/linux/vellum-remote.service.template");
    expect(unit).toContain(
      "ExecStart=@VELLUM_COMMAND_RUNTIME_ROOT@/resources/systemd/vellum-command-remote-launch",
    );
    expect(unit).toContain(
      "ConditionFileIsExecutable=@VELLUM_COMMAND_RUNTIME_ROOT@/resources/bin/vellum-command-remote",
    );
    expect(unit).not.toMatch(/Xvfb|xauth|mcookie/u);
    expect(unit).not.toMatch(/User=|Group=|Capability|\/opt\//u);
  });

  it("launcher invokes resources/bin/vellum-command-remote without Xvfb", async () => {
    const launcher = await readRepo("build/linux/vellum-remote-launch");
    expect(launcher).toContain("resources/bin/vellum-command-remote");
    expect(launcher).toContain("unset DISPLAY WAYLAND_DISPLAY XAUTHORITY");
    expect(launcher).toContain("displayless vellum-command-remote payload is unavailable");
    expect(launcher).not.toMatch(/Xvfb|xauth|mcookie/u);
    expect(launcher).not.toMatch(/--ozone-platform|--vellum-headless|ELECTRON_RUN_AS_NODE/u);
  });
});
