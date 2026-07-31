import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeLinuxRuntimeArtifact, linuxRuntimeArchiveName, linuxRuntimeArtifactName, validateLinuxRuntimeArchive } from "../scripts/finalize-linux-package";

describe("Linux userland runtime package contract", () => {
  it("asks electron-builder for only a Linux directory and packages no privileged resources", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { build: { linux: Record<string, unknown> } };
    expect(pkg.build.linux.target).toEqual(["dir"]);
    expect(JSON.stringify(pkg.build.linux)).not.toMatch(/deb|apparmor|sudo|release-installer|release-bridge|\/opt\//iu);
    const script = await readFile(new URL("../scripts/package-app-linux.sh", import.meta.url), "utf8");
    expect(script).toContain("electron-builder --linux dir --x64");
    expect(script).not.toMatch(/\bdeb\b|dpkg|sudo|\/opt\//iu);
    expect(script).toContain("audit-linux-package.ts\" --runtime");
  });

  it("materializes a named tree, archive, and digest manifest", async () => {
    const release = await mkdtemp(path.join(tmpdir(), "vellum-runtime-finalize-"));
    try {
      const name = linuxRuntimeArtifactName({ version: "0.1.0", arch: "x64" });
      expect(name).toBe("vellum-runtime-0.1.0-linux-x64");
      expect(linuxRuntimeArchiveName({ version: "0.1.0", arch: "x64" })).toBe(`${name}.tar.gz`);
      await mkdir(path.join(release, "linux-unpacked"));
      await writeFile(path.join(release, "linux-unpacked", "vellum"), "runtime", { mode: 0o755 });
      const result = await finalizeLinuxRuntimeArtifact({ releaseDirectory: release, version: "0.1.0", arch: "x64" });
      expect(result.artifact).toBe(path.join(release, name));
      expect((await readFile(result.archive)).byteLength).toBeGreaterThan(0);
      expect(() => validateLinuxRuntimeArchive({ archive: result.archive, artifactName: name })).not.toThrow();
      await expect(readFile(result.manifest, "utf8")).resolves.toContain('"schema": "vellum/linux-userland-runtime/v1"');
    } finally { await rm(release, { recursive: true, force: true }); }
  });
});
