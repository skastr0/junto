/**
 * Displayless Linux Remote product contract.
 *
 * Packaging ships bundled Node + resources/bin/vellum-remote + app-remote
 * entry, rebuilds node-pty for that Node ABI, and never uses
 * ELECTRON_RUN_AS_NODE or Bun --compile for the product remote.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINUX_RUNTIME_REQUIRED_FILES } from "../scripts/audit-linux-package";
import {
  DEFAULT_NODE_REMOTE_VERSION,
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
  vellumRemoteWrapperScript,
} from "../scripts/build-linux-remote-runtime";

const readRepo = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

describe("Linux remote displayless packaging helpers", () => {
  it("pins Node 22 LTS and names the official linux-x64 archive", () => {
    expect(DEFAULT_NODE_REMOTE_VERSION).toMatch(/^22\./u);
    expect(requireNodeRemoteVersion("22.18.0")).toBe("22.18.0");
    expect(() => requireNodeRemoteVersion("20.18.0")).toThrow(/22/u);
    expect(() => requireNodeRemoteVersion("not-a-version")).toThrow(/semver/u);
    expect(nodeLinuxX64ArchiveName("22.18.0")).toBe(
      "node-v22.18.0-linux-x64.tar.gz",
    );
    expect(nodeLinuxX64ArchiveUrl("22.18.0")).toBe(
      "https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.gz",
    );
    expect(resolveNodeRemoteVersion({})).toBe(DEFAULT_NODE_REMOTE_VERSION);
    expect(resolveNodeRemoteVersion({ NODE_REMOTE_VERSION: "22.17.1" })).toBe(
      "22.17.1",
    );
  });

  it("refuses Node archives without the reviewed linux-x64 digest pin", () => {
    expect(pinnedNodeLinuxX64ArchiveSha256("22.18.0")).toBe(
      PINNED_NODE_LINUX_X64_ARCHIVE_SHA256["22.18.0"],
    );
    expect(pinnedNodeLinuxX64ArchiveSha256("22.18.0")).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => pinnedNodeLinuxX64ArchiveSha256("22.17.1")).toThrow(
      /no reviewed Node linux-x64 archive digest/u,
    );
  });

  it("wrapper execs bundled node on app-remote entry without ELECTRON_RUN_AS_NODE", () => {
    const script = vellumRemoteWrapperScript();
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("resources/bin/vellum-remote");
    expect(script).toContain(REMOTE_NODE_RELATIVE);
    expect(script).toContain(REMOTE_ENTRY_RELATIVE);
    expect(script).toContain('exec "$node" "$entry" "$@"');
    expect(script).toContain("unset ELECTRON_RUN_AS_NODE");
    expect(script).not.toMatch(/ELECTRON_RUN_AS_NODE=1|bun |Xvfb|xauth|mcookie/u);
    expect(script).not.toMatch(/\/usr\/bin\/node|command -v node|type node/u);
  });

  it("fails closed with a clear message when the remote JS entry is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-remote-entry-"));
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
      ).rejects.toThrow(/out\/remote\/vellum-remote\.js/u);
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
    const root = await mkdtemp(path.join(tmpdir(), "vellum-remote-layout-"));
    try {
      const runtime = path.join(root, "runtime");
      await mkdir(runtime, { recursive: true });
      await mkdir(path.join(root, "out", "remote"), { recursive: true });
      await writeFile(
        path.join(root, REMOTE_ENTRY_SOURCE_RELATIVE),
        'console.log("remote-placeholder");\n',
        { mode: 0o644 },
      );
      const receipt = await installLinuxRemoteRuntime({
        repoRoot: root,
        runtimeRoot: runtime,
        requireEntry: true,
        skipNativeRebuild: true,
      });
      expect(receipt.ok).toBe(true);
      expect(receipt.wrapperPath).toBe(
        path.join(runtime, REMOTE_WRAPPER_RELATIVE),
      );
      expect(receipt.entryPath).toBe(path.join(runtime, REMOTE_ENTRY_RELATIVE));
      const wrapper = await readFile(receipt.wrapperPath, "utf8");
      expect(wrapper).toContain("unset ELECTRON_RUN_AS_NODE");
      const entry = await readFile(receipt.entryPath, "utf8");
      expect(entry).toContain("remote-placeholder");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Linux remote displayless product contracts", () => {
  it("audit requires bundled node, vellum-remote, and app-remote entry", () => {
    for (const required of LINUX_REMOTE_RUNTIME_REQUIRED_FILES) {
      expect(LINUX_RUNTIME_REQUIRED_FILES).toContain(required);
    }
    expect(LINUX_RUNTIME_REQUIRED_FILES).toEqual(
      expect.arrayContaining([
        "resources/bin/node",
        "resources/bin/vellum-remote",
        "resources/app-remote/vellum-remote.js",
      ]),
    );
  });

  it("package + finalize paths stage displayless remote inside the dir archive", async () => {
    const packageScript = await readRepo("scripts/package-app-linux.sh");
    expect(packageScript).toContain("build-linux-remote-runtime.ts");
    expect(packageScript).toContain("linux-unpacked");
    // Comments may name the forbidden flag; assignment/export is the product foul.
    expect(packageScript).not.toMatch(/ELECTRON_RUN_AS_NODE\s*=/u);
    expect(packageScript).not.toMatch(/\bdeb\b|dpkg/u);

    const finalize = await readRepo("scripts/finalize-linux-package.ts");
    expect(finalize).toContain('"resources/bin/node"');
    expect(finalize).toContain('"resources/bin/vellum-remote"');
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

  it("user service template is displayless and pinned to vellum-remote", async () => {
    const unit = await readRepo("build/linux/vellum-remote.service.template");
    expect(unit).toContain(
      "ExecStart=@VELLUM_RUNTIME_ROOT@/resources/systemd/vellum-remote-launch",
    );
    expect(unit).toContain(
      "ConditionFileIsExecutable=@VELLUM_RUNTIME_ROOT@/resources/bin/vellum-remote",
    );
    expect(unit).not.toMatch(/Xvfb|xauth|mcookie/u);
    expect(unit).not.toMatch(/User=|Group=|Capability|\/opt\//u);
  });

  it("launcher invokes resources/bin/vellum-remote without Xvfb", async () => {
    const launcher = await readRepo("build/linux/vellum-remote-launch");
    expect(launcher).toContain("resources/bin/vellum-remote");
    expect(launcher).toContain("unset DISPLAY WAYLAND_DISPLAY XAUTHORITY");
    expect(launcher).toContain("displayless vellum-remote payload is unavailable");
    expect(launcher).not.toMatch(/Xvfb|xauth|mcookie/u);
    expect(launcher).not.toMatch(/--ozone-platform|--vellum-headless|ELECTRON_RUN_AS_NODE/u);
  });
});
