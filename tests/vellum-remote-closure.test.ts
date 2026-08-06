/**
 * Architecture cement: the Node-only Remote entry and its runtime seed must
 * not pull Electron, window hosts, renderer, or browser host modules into the
 * static import graph (or the emitted remote bundle).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_VALUE_IMPORT =
  /(?:^|\n)\s*import\s+(?!type\b)[^;]*\bfrom\s+["']electron["']/u;
const FORBIDDEN_REQUIRE = /require\s*\(\s*["']electron["']\s*\)/u;
const FORBIDDEN_BROWSER_WINDOW = /\bBrowserWindow\b/u;
const FORBIDDEN_BROWSER_COMPOSITION =
  /browser\/composition(?:-host)?|startBrowserComposition|BrowserComposition/u;
const FORBIDDEN_RENDERER_IMPORT =
  /from\s+["'][^"']*\/renderer\/[^"']+["']/u;

/** Seed + entry + install helpers owned by the Node Remote lane. */
const REMOTE_ENTRY_FILES: ReadonlyArray<string> = [
  "src/main/remote-runtime.ts",
  "src/main/vellum-remote.ts",
  "src/main/vellum/supervision/install-user-service.ts",
];

describe("vellum-command-remote closure", () => {
  it("keeps remote entry sources free of electron value imports and browser composition", () => {
    const violations: string[] = [];
    for (const rel of REMOTE_ENTRY_FILES) {
      const path = join(root, rel);
      if (!existsSync(path)) {
        violations.push(`missing ${rel}`);
        continue;
      }
      const source = readFileSync(path, "utf8");
      if (FORBIDDEN_VALUE_IMPORT.test(source)) {
        violations.push(`${rel}: value import of electron`);
      }
      if (FORBIDDEN_REQUIRE.test(source)) {
        violations.push(`${rel}: require(electron)`);
      }
      if (rel !== "scripts/build-vellum-remote.ts" && FORBIDDEN_BROWSER_WINDOW.test(source)) {
        violations.push(`${rel}: window host symbol`);
      }
      if (FORBIDDEN_BROWSER_COMPOSITION.test(source)) {
        violations.push(`${rel}: browser composition`);
      }
      if (FORBIDDEN_RENDERER_IMPORT.test(source)) {
        violations.push(`${rel}: renderer import`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not import runtime.ts (Electron RootLayer) from the remote entry", () => {
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    const entry = stripComments(
      readFileSync(join(root, "src/main/vellum-remote.ts"), "utf8"),
    );
    const seed = stripComments(
      readFileSync(join(root, "src/main/remote-runtime.ts"), "utf8"),
    );
    expect(entry).not.toMatch(/from\s+["']\.\/runtime["']/u);
    expect(seed).not.toMatch(/from\s+["']\.\/runtime["']/u);
    expect(entry).not.toMatch(/\bAppRuntime\b/u);
    expect(seed).not.toMatch(/\bAppRuntime\b/u);
  });

  it("remote:build output forbids electron and browser composition when present", () => {
    const bundle = join(root, "out/remote/vellum-command-remote.js");
    if (!existsSync(bundle)) {
      // Bundle is produced by `bun run remote:build`. Absence is not a red
      // for unit CI that did not build; the build script itself rejects
      // forbidden symbols before writing.
      expect(existsSync(join(root, "scripts/build-vellum-remote.ts"))).toBe(
        true,
      );
      return;
    }
    const body = readFileSync(bundle, "utf8");
    expect(body).not.toMatch(/from\s+["']electron["']/u);
    expect(body).not.toMatch(/(?:__require|require)\s*\(\s*["']electron["']\s*\)/u);
    expect(body).not.toMatch(/\bBrowserWindow\b/u);
    expect(body).not.toMatch(/startBrowserComposition|browser\/composition/u);
    // UnsetEnvironment may list ELECTRON_RUN_AS_NODE to scrub it; forbidding
    // assignment is the product contract.
    expect(body).not.toMatch(/ELECTRON_RUN_AS_NODE\s*=\s*["']?1/u);
  });

  it("install-user-service switch is wired in the entry", () => {
    const entry = readFileSync(join(root, "src/main/vellum-remote.ts"), "utf8");
    expect(entry).toContain("--install-user-service");
    expect(entry).not.toContain("STATE_UPDATE_PREFLIGHT_SWITCH");
    expect(entry).not.toContain("withStateUpdateCandidate");
    expect(entry).not.toContain("inspectStateUpdateCandidate");
    expect(entry).not.toContain("--vellum-state-preflight");
    expect(entry).toContain("publishSystemdGenerationReadiness");
    expect(entry).toContain("installUserlandLinuxRemoteService");
    expect(entry).toContain("RemoteRuntime");
    expect(entry).not.toContain("startBrowserComposition");
    expect(entry).not.toContain("ensureHeadlessHost");
  });
});

describe("remote-runtime seed", () => {
  it("includes TerminalSessions and License layers without UpdateService", () => {
    const seed = readFileSync(join(root, "src/main/remote-runtime.ts"), "utf8");
    expect(seed).toContain("TerminalSessions");
    expect(seed).toContain("LicenseRepositoryLive");
    expect(seed).toContain("LicenseService");
    expect(seed).toContain("StateEngineLive");
    expect(seed).not.toContain("UpdateService");
    expect(seed).not.toContain("makeUpdateServiceLayer");
    expect(seed).not.toContain("BoxFleet");
    expect(seed).not.toMatch(/from\s+["']electron["']/u);
  });

  it("does not grow a second StateEngineLive construction", () => {
    const seed = readFileSync(join(root, "src/main/remote-runtime.ts"), "utf8");
    const matches = seed.match(/\bStateEngineLive\b/g) ?? [];
    // One import/use site in provideMerge is expected; refuse a second make().
    expect(seed).not.toMatch(/makeStateEngineLive\s*\(/u);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
