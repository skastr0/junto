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

  it("stores preferences without creating a second topology authority", async () => {
    const source = await readFile(
      new URL("../src/main/vellum/settings/state-schema.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("CREATE TABLE IF NOT EXISTS settings_preferences");
    expect(source).toContain(
      "CREATE TABLE IF NOT EXISTS settings_initialization",
    );
    expect(source).not.toContain("station_topology");
    expect(source.match(/\bSTRICT\b/g)).toHaveLength(2);
  });

  it("joins the aggregate from canonical normalized station state", async () => {
    const source = await readFile(
      new URL("../src/main/vellum/settings/service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("selectStationConfiguration(reader)");
    expect(source).toContain("writeStationConfiguration(");
    expect(source).not.toContain("encodedTopology");
  });

  it("does not expose local Remote configuration controls", async () => {
    const [gate, panel] = await Promise.all([
      readFile(
        new URL(
          "../src/renderer/components/StationRoleGate.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../src/renderer/components/SettingsPanel.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    expect(gate).not.toContain('pick("remote")');
    expect(gate).not.toContain("Continue as Remote");
    expect(gate).toContain("Station API");
    expect(panel).not.toContain("Pull from Command Center");
    expect(panel).toContain("Remote identity cannot be changed locally");
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
