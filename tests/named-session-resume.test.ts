import { describe, expect, it } from "vitest";
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
import { reclaimOrphanedHarnessArgv } from "../src/main/vellum/term/session-existence";

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
