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
      new URL("../src/main/vellum-command/settings/service.ts", import.meta.url),
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
      new URL("../src/main/vellum-command/settings/service.ts", import.meta.url),
      "utf8",
    );
    // Strip comments — prose may say "rename" without a file-store path.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("./legacy-import");
    expect(code).not.toMatch(
      /\breadFile\b|\bwriteFile\b|\batomicWrite\b|\brename\b/,
    );
  });

  it("stores preferences without creating a second topology authority", async () => {
    const source = await readFile(
      new URL("../src/main/vellum-command/settings/state-schema.ts", import.meta.url),
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
      new URL("../src/main/vellum-command/settings/service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("selectStationConfiguration(reader)");
    expect(source).toContain("writeStationConfiguration(");
    expect(source).not.toContain("encodedTopology");
  });

  it("does not expose local Remote configuration or station-role onboarding", async () => {
    const [gate, panel, app, service] = await Promise.all([
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
      readFile(
        new URL("../src/renderer/App.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/main/vellum-command/settings/service.ts", import.meta.url),
        "utf8",
      ),
    ]);
    // First-run role UI is retired; main auto-establishes Command Center.
    expect(gate).toContain("retired for v1");
    expect(gate).not.toContain("Look for a Command Center");
    expect(gate).not.toContain('pick("remote")');
    expect(gate).not.toContain("Continue as Remote");
    expect(app).not.toContain("StationRoleGate");
    expect(service).toContain("ensureDefaultCommandCenter");
    expect(service).toContain('role: "command-center"');
    expect(panel).not.toContain("Pull from Command Center");
    expect(panel).toContain("Allow remote managed installs");
    expect(panel).toContain("fleet: { remoteManagedInstalls: event.target.checked }");
    expect(panel).not.toContain("Remote identity cannot be changed locally");
    expect(panel).not.toContain("enroll it from an existing one");
  });

  it("boots the settings fragment in the sole StateEngine schema", async () => {
    const source = await readFile(
      new URL("../src/main/vellum-command/state/schema.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      'import { SETTINGS_STATE_SCHEMA_SQL } from "../settings/state-schema"',
    );
    expect(source).toContain("SETTINGS_STATE_SCHEMA_SQL,");
  });

  it("keeps product preferences out of renderer localStorage", async () => {
    // Renderer localStorage is not a preference store: settings live in the
    // StateEngine behind IPC. The only tolerated references are read-only
    // diagnostic switches an operator flips by hand (react-scan, VELLUM_PERF),
    // and even those may never write.
    const diagnosticSwitches = ["main.tsx", "lib/performance/perf-flag.ts"];
    const sources = await Promise.all(
      (await rendererSources()).map(async (path) => ({
        relativePath: relative(rendererRoot.pathname, path.pathname),
        source: await readFile(path, "utf8"),
      })),
    );

    const offenders = sources
      .filter(({ source }) => /\blocalStorage\b/u.test(source))
      .map(({ relativePath }) => relativePath)
      .filter((relativePath) => !diagnosticSwitches.includes(relativePath))
      .sort();

    expect(offenders).toEqual([]);

    // Every tolerated reference stays a read: no write path anywhere.
    const executable = (source: string): string =>
      source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
        .join("\n");
    for (const relativePath of diagnosticSwitches) {
      const entry = sources.find((candidate) => candidate.relativePath === relativePath);
      expect(entry, `${relativePath} must exist`).toBeDefined();
      expect(executable(entry?.source ?? "")).not.toContain("localStorage.setItem(");
      expect(executable(entry?.source ?? "")).not.toContain("localStorage.removeItem(");
    }

    // The react-scan switch stays DEV-gated.
    const mainSource = await readFile(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
    expect(mainSource).toContain("import.meta.env.DEV");
    expect(executable(mainSource).match(/\blocalStorage\b/gu)).toHaveLength(1);
  });
});
