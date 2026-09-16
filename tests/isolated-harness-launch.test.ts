import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isolatedRealHarnessPath,
  prepareIsolatedHarnessLaunch,
  realHarnessBinaryDir,
  seedIsolatedAuthFiles,
} from "../src/main/junto/term/isolated-harness-launch";
import { HARNESS_MAIL_TRANSPORT } from "../src/shared/managed-terminal-templates";

describe("prepareIsolatedHarnessLaunch", () => {
  it("seeds Devin credentials.toml only and keeps qualification false", () => {
    const operator = fs.mkdtempSync(path.join(os.tmpdir(), "junto-prep-op-"));
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "junto-prep-iso-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "junto-prep-cwd-"));
    const credRel = ".local/share/devin/credentials.toml";
    fs.mkdirSync(path.join(operator, ".local/share/devin/cli"), { recursive: true });
    fs.writeFileSync(path.join(operator, credRel), "windsurf_api_key = \"redacted\"\n");
    fs.writeFileSync(path.join(operator, ".local/share/devin/cli/sessions.db"), "history");
    const prepared = prepareIsolatedHarnessLaunch({
      harness: "devin",
      isolatedHome: isolated,
      cwd,
      operatorHome: operator,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("unreachable");
    expect(prepared.env.HOME).toBe(isolated);
    expect(prepared.env.HOME).not.toBe(operator);
    expect(prepared.seeded.copied).toEqual([credRel]);
    expect(fs.existsSync(path.join(isolated, credRel))).toBe(true);
    expect(fs.existsSync(path.join(isolated, ".local/share/devin/cli/sessions.db"))).toBe(false);
    expect(HARNESS_MAIL_TRANSPORT.devin.typedNoticeQualified).toBe(false);
    expect(
      prepareIsolatedHarnessLaunch({
        harness: "codex",
        isolatedHome: isolated,
        cwd,
        operatorHome: operator,
      }).seeded.copied,
    ).toEqual([]);
    fs.rmSync(operator, { recursive: true, force: true });
    fs.rmSync(isolated, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses operator home and does not seed", () => {
    const operator = os.homedir();
    const prepared = prepareIsolatedHarnessLaunch({
      harness: "devin",
      isolatedHome: operator,
      cwd: os.tmpdir(),
      operatorHome: operator,
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.seeded.copied).toEqual([]);
  });

  it("does not put operator HOME on the real-harness PATH prefix", () => {
    const operator = os.homedir();
    const sandboxPath = "/tmp/sandbox-bin:/usr/bin:/bin";
    const composed = isolatedRealHarnessPath({
      harness: "devin",
      operatorPath: `${operator}/.local/bin:/usr/bin`,
      sandboxPath,
    });
    expect(composed.split(":")).not.toContain(operator);
    const dir = realHarnessBinaryDir("devin", `${operator}/.local/bin:/usr/bin`);
    if (dir !== undefined) expect(dir).not.toBe(operator);
  });
});

describe("seedIsolatedAuthFiles", () => {
  it("skips missing Devin credential files without copying sessions", () => {
    const operator = fs.mkdtempSync(path.join(os.tmpdir(), "junto-seed-op-"));
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "junto-seed-iso-"));
    const result = seedIsolatedAuthFiles({
      harness: "devin",
      isolatedHome: isolated,
      operatorHome: operator,
    });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toContain(".local/share/devin/credentials.toml");
    fs.rmSync(operator, { recursive: true, force: true });
    fs.rmSync(isolated, { recursive: true, force: true });
  });
});
