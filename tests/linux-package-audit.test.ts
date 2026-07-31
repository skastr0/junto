import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditLinuxRuntime, validateElfX64, validateUserServiceTemplate } from "../scripts/audit-linux-package";
import { linuxRuntimeArtifactName } from "../scripts/finalize-linux-package";

describe("Linux userland runtime audit", () => {
  it("rejects non-x64 native binaries", () => {
    const elf = new Uint8Array(20); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf[18] = 0xb7;
    expect(() => validateElfX64(elf, "native")).toThrow(/x86-64/u);
  });
  it("requires a relocatable service placeholder and rejects privilege directives", () => {
    expect(() => validateUserServiceTemplate("ExecStart=@VELLUM_RUNTIME_ROOT@/resources/systemd/vellum-remote-launch\n")).not.toThrow();
    expect(() => validateUserServiceTemplate("User=root\nExecStart=@VELLUM_RUNTIME_ROOT@/resources/systemd/vellum-remote-launch\n")).toThrow(/privileged/u);
  });
  it("fails closed on chrome sandbox and privileged mode residue", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-runtime-audit-"));
    const runtime = path.join(root, linuxRuntimeArtifactName({ version: "0.1.0", arch: "x64" }));
    try {
      await mkdir(path.join(runtime, "resources/bin"), { recursive: true });
      await mkdir(path.join(runtime, "resources/app-remote"), { recursive: true });
      await mkdir(path.join(runtime, "resources/systemd"), { recursive: true });
      for (const file of [
        "vellum",
        "resources/app.asar",
        "resources/bin/vellum",
        "resources/bin/vellum-browser",
        "resources/bin/vellum-station",
        "resources/bin/unix-peer-pid.py",
        "resources/bin/node",
        "resources/bin/vellum-remote",
        "resources/app-remote/vellum-remote.js",
        "resources/systemd/vellum-remote-launch",
      ]) await writeFile(path.join(runtime, file), "fixture");
      await writeFile(path.join(runtime, "resources/systemd/vellum-remote.service.template"), "ExecStart=@VELLUM_RUNTIME_ROOT@/resources/systemd/vellum-remote-launch\nConditionFileIsExecutable=@VELLUM_RUNTIME_ROOT@/resources/bin/vellum-remote\n");
      await writeFile(path.join(runtime, "chrome-sandbox"), "forbidden");
      // Malformed packaged ASAR fails before residue checks (final license gate).
      await expect(auditLinuxRuntime({ runtimePath: runtime, version: "0.1.0" })).rejects.toThrow();
      await rm(path.join(runtime, "chrome-sandbox"));
      await chmod(path.join(runtime, "vellum"), 0o4755);
      await expect(auditLinuxRuntime({ runtimePath: runtime, version: "0.1.0" })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a malformed packaged app.asar license binding with nonzero failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-runtime-license-"));
    const runtime = path.join(root, linuxRuntimeArtifactName({ version: "0.1.0", arch: "x64" }));
    try {
      await mkdir(path.join(runtime, "resources/bin"), { recursive: true });
      await mkdir(path.join(runtime, "resources/app-remote"), { recursive: true });
      await mkdir(path.join(runtime, "resources/systemd"), { recursive: true });
      for (const file of [
        "vellum",
        "resources/app.asar",
        "resources/bin/vellum",
        "resources/bin/vellum-browser",
        "resources/bin/vellum-station",
        "resources/bin/unix-peer-pid.py",
        "resources/bin/node",
        "resources/bin/vellum-remote",
        "resources/app-remote/vellum-remote.js",
        "resources/systemd/vellum-remote-launch",
      ]) await writeFile(path.join(runtime, file), "not-an-asar");
      await writeFile(
        path.join(runtime, "resources/systemd/vellum-remote.service.template"),
        "ExecStart=@VELLUM_RUNTIME_ROOT@/resources/systemd/vellum-remote-launch\n",
      );
      await expect(
        auditLinuxRuntime({ runtimePath: runtime, version: "0.1.0" }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
