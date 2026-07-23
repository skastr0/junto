import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLinuxArtifactModes } from "../scripts/electron-builder-after-pack.mjs";
import {
  electronBuilderLinuxDebArtifactName,
  finalizeLinuxUnpackedArtifact,
  linuxDebArtifactName,
  linuxUnpackedArtifactName,
} from "../scripts/finalize-linux-package";
import { LINUX_DEB_DEPENDENCIES } from "../scripts/audit-linux-package";

const script = async (name: string) =>
  readFile(new URL(`../scripts/${name}`, import.meta.url), "utf8");

describe("native package pipeline contract", () => {
  it("keeps product metadata neutral and scopes Apple policy to macOS", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      description: string;
      build: {
        forceCodeSigning?: unknown;
        npmRebuild?: unknown;
        asarUnpack?: unknown;
        mac: Record<string, unknown>;
        linux: Record<string, unknown>;
        deb: Record<string, unknown>;
      };
    };
    expect(pkg.description).not.toMatch(/macOS/u);
    expect(pkg.build.forceCodeSigning).toBeUndefined();
    expect(pkg.build.npmRebuild).toBe(false);
    expect(pkg.build.mac).toMatchObject({ forceCodeSigning: true, artifactName: "${productName}-${version}-${arch}-mac.${ext}" });
    expect(pkg.build.asarUnpack).toEqual([
      "node_modules/node-pty/build/Release/{pty.node,spawn-helper}",
      "node_modules/node-pty/prebuilds/${os}-${arch}/{pty.node,spawn-helper}",
    ]);
    expect(pkg.build.linux).toMatchObject({
      artifactName: "${productName}-${version}-${arch}-linux.${ext}",
      target: ["dir", "deb"],
      executableName: "vellum",
      category: "Development",
      icon: "assets/brand/vellum-command-icon.png",
      files: [
        "out/**",
        "station/**",
        "package.json",
        "!node_modules/node-pty/prebuilds/darwin-*/**",
        "!node_modules/node-pty/prebuilds/win32-*/**",
      ],
    });
    expect(pkg.build.deb).toMatchObject({
      artifactName: "${productName}-${version}-${arch}-linux.${ext}",
      packageName: "vellum",
      afterInstall: "build/linux/after-install.sh",
      afterRemove: "build/linux/after-remove.sh",
      appArmorProfile: "build/linux/apparmor-profile",
      recommends: [],
      fpm: [
        "--before-install=build/linux/before-install.sh",
        "--before-remove=build/linux/before-remove.sh",
        "--deb-user=root",
        "--deb-group=root",
      ],
      depends: LINUX_DEB_DEPENDENCIES,
    });
  });

  it("compiles every control before dispatching to an explicit native packager", async () => {
    const build = await script("build-app.sh");
    expect(build).toContain('--target mac|linux');
    expect(build).toContain('build_compiled_cli "$REPO_ROOT/dist/vellum" src/cli/main.ts');
    expect(build).toContain('build_compiled_cli "$REPO_ROOT/dist/vellum-browser" scripts/browser-cli.ts');
    expect(build).toContain(
      'build_compiled_cli "$REPO_ROOT/dist/vellum-release-installer" scripts/linux-release-installer.ts',
    );
    expect(build).toContain(
      'build_compiled_cli "$REPO_ROOT/dist/vellum-release-bridge" scripts/linux-release-bridge.ts',
    );
    expect(build).toContain(
      '"$NODE_EXECUTABLE" "$ELECTRON_INSTALLER"',
    );
    expect(
      build.indexOf('"$NODE_EXECUTABLE" "$ELECTRON_INSTALLER"'),
    ).toBeLessThan(
      build.indexOf('electron-security-policy.ts" validate'),
    );
    expect(build).toContain("--no-compile-autoload-dotenv");
    expect(build).toContain("--no-compile-autoload-bunfig");
    expect(build).toContain('native %s packaging must run on its target OS');
    expect(build).toContain('mac) exec bash "$SCRIPT_DIR/package-app-macos.sh"');
    expect(build).toContain('linux) exec bash "$SCRIPT_DIR/package-app-linux.sh"');
    expect(build).toContain('electron-security-policy.ts" validate');
  });

  it("keeps Linux free of macOS tooling and builds both canonical artifacts", async () => {
    const linux = await script("package-app-linux.sh");
    expect(linux).toContain("set -euo pipefail\numask 0022\n");
    expect(linux).not.toContain("bun rebuild");
    expect(linux).not.toContain("electron-builder install-app-deps");
    expect(linux).toContain("Linux packaging requires Node >=22.12.0");
    expect(linux).toContain("NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 12)");
    expect(linux).toContain("bunx --no-install electron-rebuild");
    expect(linux).toContain("--only node-pty");
    expect(linux).toContain("--sequential");
    expect(linux).toContain(
      "bunx --no-install electron-builder --linux dir deb --x64",
    );
    expect(linux).toContain(
      'PACKAGE_ASSET_DIR="$(mktemp -d -t vellum-linux-assets.XXXXXX)"',
    );
    expect(linux).toContain(
      'install -m 0644 -- assets/brand/vellum-command-icon.png "$PACKAGE_ICON"',
    );
    expect(linux).toContain('rm -f -- "$PACKAGE_ICON"');
    expect(linux).toContain('rmdir -- "$PACKAGE_ASSET_DIR"');
    expect(linux).not.toContain("rm -rf");
    expect(linux).toContain('--config.linux.icon="$PACKAGE_ICON"');
    expect(linux).not.toMatch(/chmod.*assets\/brand/u);
    expect(linux).toContain('finalize-linux-package.ts');
    expect(linux).toContain('audit-linux-package.ts');
    expect(linux).toContain('electron-security-policy.ts" validate');
    expect(linux).toContain('Linux v1 packages require native x86_64');
    expect(linux).not.toMatch(/codesign|notar|PlistBuddy|launchctl|\bopen\b/u);
    const mac = await script("package-app-macos.sh");
    expect(mac).not.toContain("bun rebuild");
    expect(mac).toContain("bunx --bun electron-rebuild");
    expect(mac).toContain('bunx electron-builder --mac');
    expect(mac).toContain('notarize-app.sh');
    expect(mac).toContain('electron-security-policy.ts" validate');
  });

  it("normalizes only the completed Linux artifact without following links", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "vellum-linux-modes-"));
    const artifact = path.join(sandbox, "artifact");
    const nested = path.join(artifact, "nested");
    const regular = path.join(nested, "regular");
    const executable = path.join(nested, "executable");
    const restrictive = path.join(nested, "restrictive");
    const external = path.join(sandbox, "external");
    try {
      await mkdir(nested, { recursive: true });
      await Promise.all([
        writeFile(regular, "regular"),
        writeFile(executable, "executable"),
        writeFile(restrictive, "restrictive"),
        writeFile(external, "external"),
      ]);
      await chmod(artifact, 0o775);
      await chmod(nested, 0o775);
      await chmod(regular, 0o664);
      await chmod(executable, 0o775);
      await chmod(restrictive, 0o600);
      await chmod(external, 0o666);
      await symlink(external, path.join(artifact, "external-link"));

      await normalizeLinuxArtifactModes(artifact);

      const mode = async (candidate: string) =>
        (await lstat(candidate)).mode & 0o7777;
      await expect(mode(artifact)).resolves.toBe(0o755);
      await expect(mode(nested)).resolves.toBe(0o755);
      await expect(mode(regular)).resolves.toBe(0o644);
      await expect(mode(executable)).resolves.toBe(0o755);
      await expect(mode(restrictive)).resolves.toBe(0o600);
      await expect(mode(external)).resolves.toBe(0o666);
      expect(
        (await lstat(path.join(artifact, "external-link"))).isSymbolicLink(),
      ).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses artifact hard links before mutating their source inode", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "vellum-linux-hardlink-"));
    const artifact = path.join(sandbox, "artifact");
    const source = path.join(sandbox, "source");
    try {
      await mkdir(artifact);
      await writeFile(source, "source");
      await chmod(source, 0o664);
      await link(source, path.join(artifact, "linked-source"));

      await expect(normalizeLinuxArtifactModes(artifact)).rejects.toThrow(
        /hard-linked file/u,
      );
      expect((await lstat(source)).mode & 0o7777).toBe(0o664);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("renames electron-builder's generic Linux directory into the declared artifact identity", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-linux-package-"));
    try {
      await mkdir(path.join(release, "linux-unpacked"));
      const artifactName = linuxUnpackedArtifactName({
        productName: "Vellum Command",
        version: "0.1.0",
        arch: "x64",
      });
      expect(artifactName).toBe("Vellum Command-0.1.0-x64-linux.unpacked");
      const debName = linuxDebArtifactName({
        productName: "Vellum Command",
        version: "0.1.0",
        arch: "x64",
      });
      expect(debName).toBe("Vellum Command-0.1.0-x64-linux.deb");
      const builderDebName = electronBuilderLinuxDebArtifactName({
        productName: "Vellum Command",
        version: "0.1.0",
        arch: "x64",
      });
      expect(builderDebName).toBe("Vellum Command-0.1.0-amd64-linux.deb");
      await writeFile(path.join(release, builderDebName), "deb");
      const result = await finalizeLinuxUnpackedArtifact({
        releaseDirectory: release,
        productName: "Vellum Command",
        version: "0.1.0",
        arch: "x64",
      });
      await expect(readFile(result.manifest, "utf8")).resolves.toBe(
        '{\n  "productName": "Vellum Command",\n  "version": "0.1.0",\n  "arch": "x64",\n  "os": "linux",\n  "artifact": "Vellum Command-0.1.0-x64-linux.unpacked",\n  "deb": "Vellum Command-0.1.0-x64-linux.deb",\n  "support": {\n    "distribution": "ubuntu",\n    "version": "24.04",\n    "libc": "glibc"\n  }\n}\n',
      );
      expect(result.deb).toBe(path.join(release, debName));
      await expect(readFile(result.deb, "utf8")).resolves.toBe("deb");
      await expect(readFile(path.join(release, builderDebName), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(mkdir(result.artifact)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(release, { recursive: true, force: true });
    }
  });

  it("dispatches after-pack resources by platform and fixes their modes", async () => {
    const [afterPack, packageJson] = await Promise.all([
      script("electron-builder-after-pack.mjs"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);
    expect(afterPack).toContain('platform === "darwin"');
    expect(afterPack).toContain('platform === "linux"');
    expect(afterPack).toContain("context.packager.appInfo.productName");
    expect(afterPack).toContain('unsupported Vellum package platform');
    expect(afterPack).toContain('["vellum", "vellum-browser", "unix-peer-pid.py"]');
    expect(afterPack).toContain('"vellum-release-installer"');
    expect(afterPack).toContain('"vellum-release-bridge"');
    expect(afterPack).toContain(
      'new URL("../node_modules/electron/dist/version", import.meta.url)',
    );
    expect(afterPack).toContain(
      'writeFile(path.join(context.appOutDir, "version"), runtimeVersion',
    );
    expect(afterPack).toContain('flag: "wx"');
    expect(afterPack).toContain(
      "normalizeLinuxArtifactModes(context.appOutDir)",
    );
    expect(afterPack).not.toContain('"vellum-release-installer.sudoers"');
    expect(packageJson).not.toContain("vellum-release-installer.sudoers");
    expect(packageJson).toContain('"from": "dist/vellum-release-bridge"');
    expect(afterPack).toContain('chmod(resource, 0o755)');
    expect(afterPack).toContain('path.join(context.appOutDir, "chrome-sandbox"), 0o755');
    expect(afterPack).toContain('resetAdHocDarwinSignature: platform === "darwin"');
    expect(afterPack).toContain('getCurrentFuseWire(executablePath)');
  });

  it("installs only the narrow Vellum AppArmor profile and preserves user data", async () => {
    const [profile, beforeInstall, beforeRemove, afterInstall, afterRemove] = await Promise.all([
      readFile(new URL("../build/linux/apparmor-profile", import.meta.url), "utf8"),
      readFile(new URL("../build/linux/before-install.sh", import.meta.url), "utf8"),
      readFile(new URL("../build/linux/before-remove.sh", import.meta.url), "utf8"),
      readFile(new URL("../build/linux/after-install.sh", import.meta.url), "utf8"),
      readFile(new URL("../build/linux/after-remove.sh", import.meta.url), "utf8"),
    ]);
    expect(profile).toContain('profile vellum "/opt/Vellum Command/vellum" flags=(unconfined)');
    expect(profile.match(/\buserns,/gu)).toHaveLength(1);
    expect(profile).not.toMatch(/network,|capability,|mount,|ptrace,|signal,/u);
    expect(afterInstall).toContain("chmod 0755 \"$CHROME_SANDBOX\"");
    expect(afterInstall).toContain(
      'publish_root_file "$RELEASE_INSTALLER_SOURCE" "$INSTALLER_TARGET" 0755',
    );
    expect(afterInstall).toContain(
      'publish_root_file "$RELEASE_BRIDGE_SOURCE" "$BRIDGE_TARGET" 0755',
    );
    expect(afterInstall).toContain(
      "BRIDGE_STAGE_ROOT='/var/tmp/vellum-release-bridge'",
    );
    expect(afterInstall).toContain("chmod 1733 \"$BRIDGE_STAGE_ROOT\"");
    expect(afterInstall).toContain(
      'admit_package_owned_target "$BRIDGE_TARGET" "$BRIDGE_MARKER" "$BRIDGE_SOURCE_SHA" 755',
    );
    expect(afterInstall).not.toContain("/usr/sbin/visudo");
    expect(afterInstall).toContain(
      "ensure_root_directory /etc/sudoers.d 750",
    );
    expect(afterInstall).toContain(
      "LEGACY_SUDOERS_SHA256='a6edc7952e89af7570f74c53390aeccb8b0fe61456248762330517c7031a2f72'",
    );
    expect(afterInstall).toMatch(
      /retire_legacy_sudoers_policy[\s\S]*"\$LEGACY_SUDOERS_SHA256"[\s\S]*fail/u,
    );
    expect(afterInstall).not.toContain(
      'publish_root_file "$SUDOERS_SOURCE" "$SUDOERS_TARGET"',
    );
    expect(afterInstall).toContain(
      'admit_package_owned_target "$INSTALLER_TARGET"',
    );
    expect(beforeInstall).toContain(
      "qualify_root_file_if_present \"$INSTALLER_TARGET\" 755",
    );
    expect(beforeInstall).toContain(
      "qualify_root_file_if_present \"$BRIDGE_TARGET\" 755",
    );
    expect(afterInstall).toContain(
      'update-alternatives --install /usr/bin/vellum vellum "$WORK_CLI" 100',
    );
    expect(afterInstall).not.toContain(
      'update-alternatives --install /usr/bin/vellum vellum "$EXECUTABLE"',
    );
    expect(afterInstall).toContain("apparmor_parser --replace --write-cache --skip-read-cache");
    expect(beforeInstall).toContain("refusing an existing administrator-owned AppArmor profile");
    expect(beforeRemove).toContain('apparmor_parser --remove "$PROFILE_SOURCE"');
    expect(beforeRemove).not.toMatch(/\|\|\s*true/u);
    expect(afterInstall).toContain('ln -s "$PROFILE_SOURCE" "$PROFILE_TARGET"');
    expect(afterInstall).not.toMatch(/mv\s+-f.*PROFILE_TARGET/u);
    expect(afterRemove).toContain('upgrade|failed-upgrade|abort-install|abort-upgrade|disappear');
    expect(afterRemove).toMatch(/remove\|purge\)[\s\S]*update-alternatives/u);
    expect(afterRemove).toContain(
      "update-alternatives --remove vellum '/opt/Vellum Command/resources/bin/vellum'",
    );
    expect(afterRemove).toContain(
      'remove_package_owned_root_file "$INSTALLER_TARGET" "$INSTALLER_MARKER" 755',
    );
    expect(afterRemove).toContain(
      'remove_package_owned_root_file "$BRIDGE_TARGET" "$BRIDGE_MARKER" 755',
    );
    expect(afterRemove).toContain("preserving a nonempty release bridge stage root");
    expect(afterRemove).toMatch(
      /retire_legacy_sudoers_policy[\s\S]*"\$LEGACY_SUDOERS_SHA256"[\s\S]*preserve/u,
    );
    expect(`${beforeInstall}\n${beforeRemove}\n${afterInstall}\n${afterRemove}`).not.toMatch(
      /sysctl|disable.*apparmor|\/home\/|\$\{?HOME\}?|rm\s+-rf|\bsetcap\b|\bsetfattr\b|NOPASSWD/iu,
    );
  });

  it("pins the early packaged sandbox switch guard", async () => {
    const [guard, index] = await Promise.all([
      readFile(new URL("../src/main/vellum/packaged-sandbox-policy.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
    ]);
    expect(guard).toContain('"no-sandbox"');
    expect(guard).toContain('"disable-setuid-sandbox"');
    expect(index.indexOf("app.enableSandbox();")).toBeLessThan(
      index.indexOf("const packagedSandboxDisablingSwitch ="),
    );
    expect(index).toMatch(
      /const gotSingleInstanceLock\s*=\s*packagedSandboxDisablingSwitch === undefined && app\.requestSingleInstanceLock\(\)/u,
    );
  });
});
