import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Linux package custody", () => {
  it("contains no package hooks or root bridge assets", async () => {
    const files = await readdir(new URL("../build/linux/", import.meta.url));
    expect(files).toEqual(expect.arrayContaining(["junto-remote-launch", "junto-remote.service.template"]));
    expect(files.join("\n")).not.toMatch(/apparmor|install|remove|bridge|sudoers/iu);
    const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
    expect(packageJson).not.toMatch(/junto-release-installer|junto-release-bridge|appArmorProfile|"deb"/u);
  });
});
