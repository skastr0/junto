import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "../src/shared/station-protocol";

const root = process.cwd();

const readDocument = (path: string): string =>
  readFileSync(join(root, path), "utf8");

const normalizeProse = (source: string): string =>
  source.replace(/\s+/g, " ").trim();

describe("compatibility baseline documentation authority", () => {
  it("keeps the Station protocol at the frozen 1/1/1 policy", () => {
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual({
      preferred: 1,
      compatibleFrom: 1,
      warnBelow: 1,
    });
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(21);
  });

  it("reconciles semantic compatibility analysis with no partial down-conversion", () => {
    for (const path of [
      "AGENTS.md",
      "docs/security-doctrine.md",
      "docs/vellum-protocol.md",
    ]) {
      const prose = normalizeProse(readDocument(path));
      expect(prose, path).toContain(
        "Semantic compatibility analysis (Exact / Restricted / Unsupported) is",
      );
      expect(prose, path).toContain("accepts Exact alone");
      expect(prose, path).toContain("never a partial down-conversion");
    }
  });

  it("documents the deterministic refusal for older Command Center binaries", () => {
    for (const path of [
      "AGENTS.md",
      "docs/security-doctrine.md",
      "docs/vellum-protocol.md",
      "docs/state-architecture.md",
    ]) {
      expect(normalizeProse(readDocument(path)), path).toContain(
        "newer-than-supported",
      );
    }
  });

  it("flags the 256-generation body deletion as a scheduled-for-removal deviation", () => {
    for (const path of [
      "AGENTS.md",
      "docs/security-doctrine.md",
      "docs/state-architecture.md",
    ]) {
      const prose = normalizeProse(readDocument(path));
      expect(prose, path).toContain("256-generation window");
      expect(prose, path).toContain("scheduled for removal");
    }
  });

  it("records the narrow Effect v4 rolling-cohort dependency exception", () => {
    const prose = normalizeProse(readDocument("AGENTS.md"));
    expect(prose).toContain("rolling Effect v4 release line");
    expect(prose).toContain("maintainer-blessed beta or RC versions");
    expect(prose).toContain(
      "Snapshots, nightlies, forks, patches, pin-to-PR, and private branches remain",
    );
    expect(prose).toContain("effect@4.0.0-rc.112");
    expect(prose).toContain("No other dependency inherits this exception");
  });
});
