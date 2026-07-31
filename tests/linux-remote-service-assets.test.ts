import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateUserServiceTemplate } from "../scripts/audit-linux-package";

describe("Linux Remote userland assets", () => {
  it("uses a self-locating launcher with no privileged installation surface", async () => {
    const launcher = await readFile(new URL("../build/linux/vellum-remote-launch", import.meta.url), "utf8");
    expect(launcher).toContain('*/resources/systemd/vellum-remote-launch) release=${0%/resources/systemd/vellum-remote-launch}');
    expect(launcher).toContain('case "$release" in "$home"/.vellum/runtime/releases/*)');
    expect(launcher).toContain("resources/bin/vellum-remote");
    expect(launcher).not.toMatch(/sudo|\/opt\/|systemctl|apparmor|chrome-sandbox/iu);
  });
  it("ships a displayless unit template pinned to vellum-remote", async () => {
    const unit = await readFile(new URL("../build/linux/vellum-remote.service.template", import.meta.url), "utf8");
    expect(() => validateUserServiceTemplate(unit)).not.toThrow();
    expect(unit).toContain("ConditionFileIsExecutable=@VELLUM_RUNTIME_ROOT@/resources/bin/vellum-remote");
    expect(unit).toContain("ExecStart=@VELLUM_RUNTIME_ROOT@/resources/systemd/vellum-remote-launch");
    expect(unit).toContain("UnsetEnvironment=");
    expect(unit).not.toMatch(/^Environment=ELECTRON_OZONE/mu);
    expect(unit).not.toMatch(/^Environment=OZONE_PLATFORM/mu);
    expect(unit).not.toMatch(/User=|Group=|Capability|\/opt\//u);
  });
});
