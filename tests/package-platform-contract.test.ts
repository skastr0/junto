import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeLinuxRuntimeArtifact, linuxRuntimeArchiveName, linuxRuntimeArtifactName, linuxRuntimeTarArguments, validateLinuxRuntimeArchive } from "../scripts/finalize-linux-package";

describe("Linux userland runtime package contract", () => {
  it("asks electron-builder for only a Linux directory and packages no privileged resources", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { build: { linux: Record<string, unknown> } };
    expect(pkg.build.linux.target).toEqual(["dir"]);
    expect(JSON.stringify(pkg.build.linux)).not.toMatch(/deb|apparmor|sudo|release-installer|release-bridge|\/opt\//iu);
    const script = await readFile(new URL("../scripts/package-app-linux.sh", import.meta.url), "utf8");
    expect(script).toContain("electron-builder --linux dir --x64");
    expect(script).not.toMatch(/\bdeb\b|dpkg|sudo|\/opt\//iu);
    expect(script).toContain("audit-linux-package.ts\" --runtime");
    // Product remote is staged as bundled Node inside the same dir archive — never a second .deb path.
    expect(script).toContain("build-linux-remote-runtime.ts");
    expect(script).not.toMatch(/ELECTRON_RUN_AS_NODE\s*=/u);
    expect(script).not.toMatch(/--linux\s+deb\b|target.*deb/iu);
  });

  it("materializes a named tree, archive, and digest manifest", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-runtime-finalize-"));
    try {
      const name = linuxRuntimeArtifactName({ version: "0.1.0", arch: "x64" });
      expect(name).toBe("vellum-runtime-0.1.0-linux-x64");
      expect(linuxRuntimeArchiveName({ version: "0.1.0", arch: "x64" })).toBe(`${name}.tar.gz`);
      await mkdir(path.join(release, "linux-unpacked"));
      await writeFile(path.join(release, "linux-unpacked", "vellum-command"), "runtime", { mode: 0o755 });
      const result = await finalizeLinuxRuntimeArtifact({ releaseDirectory: release, version: "0.1.0", arch: "x64" });
      expect(result.artifact).toBe(path.join(release, name));
      expect((await readFile(result.archive)).byteLength).toBeGreaterThan(0);
      expect(() => validateLinuxRuntimeArchive({ archive: result.archive, artifactName: name })).not.toThrow();
      await expect(readFile(result.manifest, "utf8")).resolves.toContain('"schema": "vellum/linux-userland-runtime/v1"');
    } finally { await rm(release, { recursive: true, force: true }); }
  });

  it("accepts only semver x64 identities and uses non-account numeric Linux metadata", () => {
    for (const version of ["0.0.0", "1.2.3", "1.2.3-rc.1+build.7"]) {
      expect(linuxRuntimeArtifactName({ version, arch: "x64" })).toContain(version);
    }
    for (const version of ["1", "01.2.3", "1.2", "1.2.3/evil", "1.2.3 "]) {
      expect(() => linuxRuntimeArtifactName({ version, arch: "x64" })).toThrow(/version/u);
    }
    expect(() => linuxRuntimeArtifactName({ version: "1.2.3", arch: "arm64" })).toThrow(/x64/u);
    expect(linuxRuntimeTarArguments("linux")).toEqual(expect.arrayContaining(["--numeric-owner", "--owner=1000", "--group=1000", "--sort=name", "--mtime=@0"]));
    expect(linuxRuntimeTarArguments("linux").join(" ")).not.toContain("vellum");
  });

  it("rejects an archive with a second root or a symlink", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-runtime-adversarial-"));
    const artifact = "vellum-runtime-1.2.3-linux-x64";
    const archive = path.join(release, "adversarial.tar.gz");
    try {
      await mkdir(path.join(release, artifact));
      await mkdir(path.join(release, "other"));
      await writeFile(path.join(release, artifact, "ok"), "ok");
      await writeFile(path.join(release, "other", "no"), "no");
      const created = spawnSync("/usr/bin/tar", ["--create", "--gzip", "--file", archive, artifact, "other"], { cwd: release });
      expect(created.status).toBe(0);
      expect(() => validateLinuxRuntimeArchive({ archive, artifactName: artifact })).toThrow(/unexpected root/u);
      await rm(archive);
      await rm(path.join(release, "other"), { recursive: true });
      await symlink("ok", path.join(release, artifact, "linked"));
      const linked = spawnSync("/usr/bin/tar", ["--create", "--gzip", "--file", archive, artifact], { cwd: release });
      expect(linked.status).toBe(0);
      expect(() => validateLinuxRuntimeArchive({ archive, artifactName: artifact })).toThrow(/link or special/u);
    } finally { await rm(release, { recursive: true, force: true }); }
  });

  it("refuses a symlinked electron-builder output before it can escape the release directory", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-runtime-source-link-"));
    try {
      await mkdir(path.join(release, "elsewhere"));
      await symlink("elsewhere", path.join(release, "linux-unpacked"));
      await expect(finalizeLinuxRuntimeArtifact({ releaseDirectory: release, version: "1.2.3", arch: "x64" })).rejects.toThrow(/non-symlink directory/u);
    } finally { await rm(release, { recursive: true, force: true }); }
  });
});
