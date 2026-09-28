import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every Electron or Junto process a test, probe or smoke launches runs with
// Chromium's --mute-audio, so no cue from a test app reaches the operator's
// speakers. The operator's installed app never sees the switch.

const ROOT = process.cwd();
const SCANNED = ["e2e", "scripts"];
const SOURCE = /\.(?:[cm]?[jt]s)$/u;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return SOURCE.test(name) ? [path] : [];
  });

/** The balanced `{...}` starting at `open`. */
const objectAt = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced launch options at ${String(open)}`);
};

// Playwright's electron.launch, or a process-plane spawn whose command is the
// Electron binary or the packaged app executable.
const LAUNCH_CALL = /(?:electron\.launch|\.spawnGroup)\(\s*\{/gu;
const ELECTRON_COMMAND = /electron\.launch|\bcommand:\s*(?:electronPath|executable)\b/u;
const MUTED = /"--mute-audio"|\bMUTE_AUDIO\b/u;

type LaunchSite = { readonly file: string; readonly line: number; readonly options: string };

const launchSites = (): LaunchSite[] =>
  SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(LAUNCH_CALL)].flatMap((match) => {
      const options = objectAt(text, match.index + match[0].length - 1);
      if (!ELECTRON_COMMAND.test(`${match[0]}${options}`)) return [];
      const line = text.slice(0, match.index).split("\n").length;
      return [{ file: relative(ROOT, path), line, options }];
    });
  });

describe("test launches are silent", () => {
  const sites = launchSites();

  it("finds the known launch paths", () => {
    const files = new Set(sites.map((site) => site.file));
    for (const file of [
      "e2e/harness/launch.ts",
      "e2e/scenarios/quit-bound.spec.ts",
      "scripts/packaged-runtime-smoke.ts",
      "scripts/linux-ci-packaged-smoke.ts",
      "scripts/linux-packaged-pty-smoke.ts",
      "scripts/browser-electron-containment-probe.ts",
      "scripts/browser-electron-profile-wipe-probe.ts",
      "scripts/browser-electron-renderer-crash-recovery-probe.ts",
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it("passes --mute-audio on every launch", () => {
    const loud = sites.filter((site) => !MUTED.test(site.options)).map((site) => `${site.file}:${String(site.line)}`);
    expect(loud).toEqual([]);
  });

  it("binds the harness constant to the Chromium switch", () => {
    const harness = readFileSync(join(ROOT, "e2e/harness/launch.ts"), "utf8");
    expect(harness).toMatch(/const MUTE_AUDIO = "--mute-audio";/u);
  });
});
