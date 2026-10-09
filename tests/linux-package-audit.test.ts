import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditLinuxRuntime, validateElfX64 } from "../scripts/audit-linux-package";
import { linuxRuntimeArtifactName } from "../scripts/finalize-linux-package";

describe("Linux userland runtime audit", () => {
  it("rejects non-x64 native binaries", () => {
    const elf = new Uint8Array(20); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf[18] = 0xb7;
    expect(() => validateElfX64(elf, "native")).toThrow(/x86-64/u);
  });
  it("fails closed on chrome sandbox and privileged mode residue", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "junto-runtime-audit-"));
    const runtime = path.join(root, linuxRuntimeArtifactName({ version: "0.1.0", arch: "x64" }));
    try {
      await mkdir(path.join(runtime, "resources/bin"), { recursive: true });
      for (const file of [
        "junto",
        "resources/app.asar",
        "resources/bin/junto",
      ]) await writeFile(path.join(runtime, file), "fixture");
      await writeFile(path.join(runtime, "chrome-sandbox"), "forbidden");
      await expect(auditLinuxRuntime({ runtimePath: runtime, version: "0.1.0" })).rejects.toThrow(/privileged packaging residue/u);
      await rm(path.join(runtime, "chrome-sandbox"));
      await chmod(path.join(runtime, "junto"), 0o4755);
      // Non-root macOS often strips setuid; only assert when the platform retained privileged bits.
      const mode = (await lstat(path.join(runtime, "junto"))).mode;
      if ((mode & 0o7000) !== 0) {
        await expect(auditLinuxRuntime({ runtimePath: runtime, version: "0.1.0" })).rejects.toThrow(/privileged mode bits/u);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
