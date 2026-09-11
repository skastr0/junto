import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  blockedFindings,
  collectFindings,
  loadExceptions,
  parseAuditJson,
  parseEnabledLinuxTargets,
  parseLockPackages,
  satisfiesVulnerable,
  summarize,
  type Advisory,
  type Exception,
} from "../scripts/audit-dependencies";

const root = join(import.meta.dirname, "..");

const advisory = (over: Partial<Advisory> & Pick<Advisory, "url">): Advisory => ({
  id: 1,
  title: "test",
  severity: "high",
  vulnerable_versions: "<1.0.0",
  ...over,
});

describe("dependency audit classification", () => {
  it("matches advisory version ranges without Bun.semver", () => {
    expect(satisfiesVulnerable("7.5.15", "<=7.5.15")).toBe(true);
    expect(satisfiesVulnerable("7.5.22", "<=7.5.20")).toBe(false);
    expect(satisfiesVulnerable("0.27.7", ">=0.27.3 <0.28.1")).toBe(true);
    expect(satisfiesVulnerable("8.10.2", ">=7.0.0 <7.29.0")).toBe(false);
  });

  it("counts unique GHSAs separately from advisory rows", () => {
    const audit = parseAuditJson(
      JSON.stringify({
        undici: [
          advisory({ id: 1, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", vulnerable_versions: ">=7.0.0 <7.29.0" }),
          advisory({ id: 2, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", vulnerable_versions: "<6.28.0" }),
        ],
      }),
    );
    expect(summarize(audit, []).advisoryRows).toBe(2);
    expect(summarize(audit, []).uniqueGhsas).toBe(1);
  });

  it("matches only lock copies inside an advisory range", () => {
    const lock = parseLockPackages(`
    "undici": ["undici@8.10.2", "", {}, "sha"],
    "@electron/get/undici": ["undici@7.28.0", "", {}, "sha"],
    "node-gyp/undici": ["undici@6.25.0", "", {}, "sha"],
`);
    const findings = collectFindings({
      audit: {
        undici: [advisory({ url: "https://github.com/advisories/GHSA-8xcm-r25x-g524", vulnerable_versions: ">=7.0.0 <7.29.0" })],
      },
      lock,
      linuxTargets: ["dir"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.package).toBe("undici");
  });

  it("does not fail AppImage packaging findings when AppImage is disabled", () => {
    const lock = parseLockPackages(`    "app-builder-lib": ["app-builder-lib@26.8.1", "", {}, "sha"],\n`);
    const findings = collectFindings({
      audit: {
        "app-builder-lib": [
          advisory({
            url: "https://github.com/advisories/GHSA-7g7r-gx96-252g",
            vulnerable_versions: "<26.15.0",
          }),
        ],
      },
      lock,
      linuxTargets: ["dir"],
    });
    expect(
      blockedFindings({ findings, exceptions: [], linuxTargets: ["dir"], lock }),
    ).toHaveLength(0);
    expect(
      blockedFindings({ findings, exceptions: [], linuxTargets: ["AppImage"], lock }),
    ).toHaveLength(1);
  });

  it("rejects expired exceptions and unknown scopes", () => {
    expect(() =>
      loadExceptions(
        JSON.stringify({
          schema: 1,
          exceptions: [
            {
              package: "esbuild",
              ghsa: "GHSA-g7r4-m6w7-qqqr",
              versions: ["0.27.7"],
              lockfilePaths: ["vite/esbuild"],
              scope: "dev",
              reason: "x",
              owner: "@skastr0",
              expires: "2026-10-11",
              tracking: "docs/dependency-remediation.md#esbuild",
            },
          ],
        }),
      ),
    ).toThrow(/malformed exception/u);
    const exceptions: readonly Exception[] = [
      {
        package: "esbuild",
        ghsa: "GHSA-g7r4-m6w7-qqqr",
        versions: ["0.27.7"],
        lockfilePaths: ["vite/esbuild"],
        scope: "development",
        reason: "x",
        owner: "@skastr0",
        expires: "2026-01-01",
        tracking: "docs/dependency-remediation.md#esbuild",
      },
    ];
    const lock = parseLockPackages(`    "vite/esbuild": ["esbuild@0.27.7", "", {}, "sha"],\n`);
    const findings = collectFindings({
      audit: {
        esbuild: [advisory({ url: "https://github.com/advisories/GHSA-g7r4-m6w7-qqqr", vulnerable_versions: ">=0.27.3 <0.28.1" })],
      },
      lock,
      linuxTargets: ["dir"],
    });
    expect(
      blockedFindings({
        findings,
        exceptions,
        linuxTargets: ["dir"],
        lock,
        now: new Date("2026-09-11T00:00:00.000Z"),
      }),
    ).toHaveLength(1);
  });

  it("always blocks remaining tar advisories", () => {
    const lock = parseLockPackages(`    "tar": ["tar@7.5.15", "", {}, "sha"],\n`);
    const findings = collectFindings({
      audit: {
        tar: [
          advisory({
            severity: "moderate",
            url: "https://github.com/advisories/GHSA-vmf3-w455-68vh",
            vulnerable_versions: "<=7.5.15",
          }),
        ],
      },
      lock,
      linuxTargets: ["dir"],
    });
    expect(blockedFindings({ findings, exceptions: [], linuxTargets: ["dir"], lock })).toHaveLength(1);
  });

  it("reads enabled linux targets from package.json", () => {
    expect(parseEnabledLinuxTargets(readFileSync(join(root, "package.json"), "utf8"))).toEqual(["dir"]);
  });
});

describe("dependency audit CLI", () => {
  it("passes against the current lockfile and exception list", () => {
    const result = spawnSync("bun", ["scripts/audit-dependencies.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout) as { blocked: number; uniqueGhsas: number; advisoryRows: number };
    expect(payload.blocked).toBe(0);
    expect(payload.advisoryRows).toBeGreaterThanOrEqual(payload.uniqueGhsas);
  });

  it("fails closed on non-JSON registry output", () => {
    expect(() => parseAuditJson("not-json")).toThrow();
  });
});
