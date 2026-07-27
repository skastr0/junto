import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("settings state architecture", () => {
  it("keeps the canonical repository on the pure StateEngine seam", async () => {
    const source = await readFile(
      new URL("../src/main/vellum/settings/service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "../state/service"');
    expect(source).not.toContain('from "../state/engine"');
    expect(source).not.toContain("node:sqlite");
    expect(source).not.toContain("writeTopologySeal");
    expect(source).not.toContain("atomicWrite");
  });

  it("has no local file-store migration or fallback path", async () => {
    const source = await readFile(
      new URL("../src/main/vellum/settings/service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("./legacy-import");
    expect(source).not.toMatch(
      /\breadFile\b|\bwriteFile\b|\batomicWrite\b|\brename\b/,
    );
  });

  it("separates preference and protected-topology storage", async () => {
    const source = await readFile(
      new URL("../src/main/vellum/settings/state-schema.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("CREATE TABLE IF NOT EXISTS settings_preferences");
    expect(source).toContain(
      "CREATE TABLE IF NOT EXISTS settings_station_topology",
    );
    expect(source).toContain(
      "CREATE TABLE IF NOT EXISTS settings_initialization",
    );
    expect(source.match(/\bSTRICT\b/g)).toHaveLength(3);
  });

  it("boots the settings fragment in the sole StateEngine schema", async () => {
    const source = await readFile(
      new URL("../src/main/vellum/state/schema.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      'import { SETTINGS_STATE_SCHEMA_SQL } from "../settings/state-schema"',
    );
    expect(source).toContain("SETTINGS_STATE_SCHEMA_SQL,");
  });
});
