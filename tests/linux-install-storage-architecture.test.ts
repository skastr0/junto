import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const storage = new URL("../src/main/junto/update/linux-install-storage.ts", import.meta.url);
const install = new URL("../src/main/junto/update/linux-install.ts", import.meta.url);

describe("Linux install storage architecture", () => {
  it("keeps recursive deletion behind minted install-tree authority", async () => {
    const storageSource = await readFile(storage, "utf8");
    const installSource = await readFile(install, "utf8");
    expect(storageSource).toContain("RetirableLinuxInstallTree");
    expect(storageSource).toContain("await rm(payload, { recursive: true, force: false })");
    expect(storageSource).not.toMatch(/export const removeOwnedAttempt/u);
    expect(installSource).not.toMatch(/removeOwnedAttempt/u);
    expect(installSource).not.toMatch(/rm\([^)]*recursive: true/u);
    expect(installSource).toContain("and the active launcher are never retired or rolled back here.");
  });
});
