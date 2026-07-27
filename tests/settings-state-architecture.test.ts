import { readdir, readFile } from "node:fs/promises";
import { extname, relative } from "node:path";
import { describe, expect, it } from "vitest";

const rendererRoot = new URL("../src/renderer/", import.meta.url);

const rendererSources = async (
  directory: URL = rendererRoot,
): Promise<ReadonlyArray<URL>> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<ReadonlyArray<URL>> => {
      const path = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        path.pathname = `${path.pathname}/`;
        return rendererSources(path);
      }
      return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
};

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
    expect(gate).not.toContain("hostsConfigureRemote");
    expect(gate).not.toMatch(/hostsTest\s*\(/);
    expect(gate).toContain("Station API");
    expect(gate).toContain("hostsDiscoverPeers");
    expect(gate).toContain("Look for machines on Tailscale");
    expect(gate).toContain("self-assigns Remote");
    expect(gate).toContain("You cannot enroll this machine yourself");
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

  it("keeps product preferences out of renderer localStorage", async () => {
    const main = new URL("../src/renderer/main.tsx", import.meta.url);
    const offenders = (
      await Promise.all(
        (await rendererSources())
          .filter((path) => path.href !== main.href)
          .map(async (path) => ({
            path,
            source: await readFile(path, "utf8"),
          })),
      )
    )
      .filter(({ source }) => /\blocalStorage\b/u.test(source))
      .map(({ path }) => relative(rendererRoot.pathname, path.pathname))
      .sort();

    expect(offenders).toEqual([]);

    // The sole remaining reference is a DEV-gated render profiler switch,
    // never a product preference or production write path.
    const mainSource = await readFile(main, "utf8");
    const executableMain = mainSource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(mainSource).toContain("import.meta.env.DEV");
    expect(mainSource.match(/\blocalStorage\b/gu)).toHaveLength(2);
    expect(executableMain.match(/\blocalStorage\b/gu)).toHaveLength(1);
    expect(executableMain).not.toContain("localStorage.setItem(");
  });
});
