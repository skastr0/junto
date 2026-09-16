import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateUserServiceTemplate } from "../scripts/audit-linux-package";

describe("Linux Remote userland assets", () => {
  it("uses a self-locating launcher with no privileged installation surface", async () => {
    const launcher = await readFile(new URL("../build/linux/junto-remote-launch", import.meta.url), "utf8");
    expect(launcher).toContain('*/resources/systemd/junto-remote-launch) release=${0%/resources/systemd/junto-remote-launch}');
    expect(launcher).toContain('case "$release" in "$home"/.junto/runtime/releases/*)');
    expect(launcher).toContain("resources/bin/junto-remote");
    expect(launcher).not.toMatch(/sudo|\/opt\/|systemctl|apparmor|chrome-sandbox/iu);
  });
  it("ships a displayless unit template pinned to junto-remote", async () => {
    const unit = await readFile(new URL("../build/linux/junto-remote.service.template", import.meta.url), "utf8");
    expect(() => validateUserServiceTemplate(unit)).not.toThrow();
    expect(unit).toContain("ConditionFileIsExecutable=@JUNTO_RUNTIME_ROOT@/resources/bin/junto-remote");
    expect(unit).toContain("ExecStart=@JUNTO_RUNTIME_ROOT@/resources/systemd/junto-remote-launch");
    expect(unit).toContain("UnsetEnvironment=");
    expect(unit).not.toMatch(/^Environment=ELECTRON_OZONE/mu);
    expect(unit).not.toMatch(/^Environment=OZONE_PLATFORM/mu);
    expect(unit).not.toMatch(/User=|Group=|Capability|\/opt\//u);
  });
});
