import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const rendererFiles = [
  "../src/renderer/components/SettingsPanel.tsx",
  "../src/renderer/components/fleet/FleetDetailPanel.tsx",
  "../src/renderer/components/LinuxHostCapabilities.tsx",
  "../src/renderer/lib/linux-host-capability-presentation.ts",
] as const;

describe("Linux host preparation UI", () => {
  it("never collects an administrator password in renderer surfaces", async () => {
    for (const file of rendererFiles) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/type=["']password["']/u);
      expect(source).not.toContain("authorization: { request, password }");
      expect(source).not.toContain("admin-password");
      expect(source).not.toMatch(/\bsudo\b/u);
      expect(source).not.toContain("--no-sandbox");
    }
  });
});
