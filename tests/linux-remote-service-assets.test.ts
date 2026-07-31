import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateUserServiceTemplate } from "../scripts/audit-linux-package";

describe("Linux Remote userland assets", () => {
  it("uses a self-locating launcher with no privileged installation surface", async () => {
    const launcher = await readFile(new URL("../build/linux/vellum-remote-launch", import.meta.url), "utf8");
    expect(launcher).toContain('RUNTIME_ROOT=$(CDPATH= cd -- "$SELF_DIR/../.." && pwd -P)');
    expect(launcher).toContain('exec "$VELLUM" --vellum-headless --ozone-platform=x11');
    expect(launcher).not.toMatch(/sudo|\/opt\/|systemctl|apparmor|chrome-sandbox/iu);
  });
  it("ships a template the operator expands at their chosen runtime location", async () => {
    const unit = await readFile(new URL("../build/linux/vellum-remote.service.template", import.meta.url), "utf8");
    expect(() => validateUserServiceTemplate(unit)).not.toThrow();
    expect(unit).not.toMatch(/User=|Group=|Capability|\/opt\//u);
  });
});
