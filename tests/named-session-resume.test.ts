import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  namedHarnessSessionId,
  resolveManagedLaunch,
  stripIdlessSessionContinue,
} from "../src/shared/managed-terminal-launch";
import {
  HARNESS_IDS,
  MANAGED_TERMINAL_TEMPLATES,
  type ManagedTerminalTemplate,
} from "../src/shared/managed-terminal-templates";
import {
  __setSessionExistenceHomeForTest,
  launchArgvUsesResume,
  parseHarnessSessionArgv,
  reclaimOrphanedHarnessArgv,
} from "../src/main/vellum-command/term/session-existence";

describe("named session resume law", () => {
  it("no template uses an id-less continue flag as resume", () => {
    for (const id of HARNESS_IDS) {
      const flag = MANAGED_TERMINAL_TEMPLATES[id].argvSpec.resumeFlag;
      expect(flag === "--continue" || flag === "-c").toBe(false);
      expect(MANAGED_TERMINAL_TEMPLATES[id].argvSpec.prefix).not.toContain(
        "--continue",
      );
    }
  });

  it("launch emits resume only with an explicit id", () => {
    const resumed = resolveManagedLaunch("claude", { resumeId: "SID-1" }).argv;
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("SID-1");
    expect(resumed).not.toContain("--continue");

    const fresh = resolveManagedLaunch("claude", {}).argv;
    expect(fresh).not.toContain("--resume");
    expect(fresh).not.toContain("--continue");

    const blank = resolveManagedLaunch("claude", { resumeId: "  " }).argv;
    expect(blank).not.toContain("--resume");
    expect(blank).not.toContain("--continue");
  });

  it("refuses --continue even when a template names it as resumeFlag", () => {
    const bogus: ManagedTerminalTemplate = {
      ...MANAGED_TERMINAL_TEMPLATES.claude,
      argvSpec: {
        ...MANAGED_TERMINAL_TEMPLATES.claude.argvSpec,
        resumeFlag: "--continue",
      },
    };
    const argv = resolveManagedLaunch(bogus, { resumeId: "SID-1" }).argv;
    expect(argv).not.toContain("--continue");
    expect(argv).not.toContain("SID-1");
  });

  it("strips --continue from spawn argv", () => {
    expect(stripIdlessSessionContinue(["agent", "--continue", "--model", "auto"])).toEqual(
      ["agent", "--model", "auto"],
    );
    expect(namedHarnessSessionId("--continue")).toBeUndefined();
    expect(
      reclaimOrphanedHarnessArgv(["claude", "--continue", "--model", "opus"]),
    ).toEqual(["claude", "--model", "opus"]);
  });
});

/**
 * Pi's `-r` / `--resume` is "Select a session to resume" — the interactive
 * picker (verified on pi 0.84.2). Its named form is `--session <path|id>`,
 * which the template already declared while this reclaim path still emitted
 * `-r` for every harness but Claude.
 */
describe("reclaim uses the harness's own named-resume flag", () => {
  const temps: string[] = [];

  afterEach(() => {
    __setSessionExistenceHomeForTest(undefined);
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const homeWithPiSession = (cwdDir: string, sid: string): string => {
    const home = mkdtempSync(join(tmpdir(), "vellum-pi-reclaim-"));
    temps.push(home);
    const dir = join(home, ".pi", "agent", "sessions", cwdDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `2026-08-25T10-00-00-000Z_${sid}.jsonl`),
      '{"type":"session","version":3}\n',
    );
    return home;
  };

  it("reclaims a pi pin as --session, never the -r picker", () => {
    const cwd = "/Users/me/proj";
    const sid = "01a7c3d9-4e11-7bb2-9f04-6d2b8ac51e73";
    const pin = ["pi", "--session-id", sid, "--model", "auto"];

    // No proof under this host's sessions root — the pin argv is left alone.
    const empty = mkdtempSync(join(tmpdir(), "vellum-pi-empty-"));
    temps.push(empty);
    __setSessionExistenceHomeForTest(empty);
    expect(reclaimOrphanedHarnessArgv(pin, cwd)).toEqual(pin);

    __setSessionExistenceHomeForTest(homeWithPiSession("--Users-me-proj--", sid));
    const reclaimed = reclaimOrphanedHarnessArgv(pin, cwd);
    expect(reclaimed).toEqual(["pi", "--session", sid, "--model", "auto"]);
    expect(reclaimed).not.toContain("-r");
    expect(reclaimed).not.toContain("--resume");

    // Already reclaimed → idempotent, not re-flagged.
    expect(reclaimOrphanedHarnessArgv(reclaimed, cwd)).toEqual(reclaimed);
  });

  it("reads the flag from the template, so grok and claude keep theirs", () => {
    expect(MANAGED_TERMINAL_TEMPLATES.pi.argvSpec.resumeFlag).toBe("--session");
    expect(MANAGED_TERMINAL_TEMPLATES.grok.argvSpec.resumeFlag).toBe("-r");
    expect(MANAGED_TERMINAL_TEMPLATES.claude.argvSpec.resumeFlag).toBe(
      "--resume",
    );
  });

  it("counts pi --session as a resume, and --session-id as a pin", () => {
    const sid = "01a7c3d9-4e11-7bb2-9f04-6d2b8ac51e73";
    expect(parseHarnessSessionArgv(["pi", "--session", sid])).toEqual({
      harness: "pi",
      sessionId: sid,
      mode: "resume",
    });
    expect(parseHarnessSessionArgv(["pi", "--session-id", sid])).toEqual({
      harness: "pi",
      sessionId: sid,
      mode: "pin",
    });
    // The isolation guard and dead-resume fail-open both key on this.
    expect(launchArgvUsesResume(["pi", "--session", sid])).toBe(true);
    expect(launchArgvUsesResume(["pi", "--session-id", sid])).toBe(false);
    expect(
      launchArgvUsesResume(["pi", "--session-dir", "/tmp/sessions"]),
    ).toBe(false);
  });
});
