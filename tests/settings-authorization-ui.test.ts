import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const rendererFiles = [
  "../src/renderer/components/SettingsPanel.tsx",
  "../src/renderer/components/fleet/FleetDetailPanel.tsx",
] as const;

describe("Linux host preparation UI", () => {
  it("never collects an administrator password in renderer surfaces", async () => {
    for (const file of rendererFiles) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/type=["']password["']/u);
      expect(source).not.toContain("authorization: { request, password }");
      expect(source).not.toContain("admin-password");
      expect(source).not.toContain("--no-sandbox");
    }
  });
});
