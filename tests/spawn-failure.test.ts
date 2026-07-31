import { describe, expect, it } from "vitest";
import {
  classifySpawnFailure,
  harnessDisplayName,
  harnessNotInstalledMessage,
  isMissingExecutableError,
} from "../src/shared/spawn-failure";

describe("harnessDisplayName / harnessNotInstalledMessage", () => {
  it("uses template display names, not raw binaries", () => {
    expect(harnessDisplayName("claude")).toBe("Claude Code");
    expect(harnessDisplayName("codex")).toBe("Codex");
    expect(harnessDisplayName("grok")).toBe("Grok");
    expect(harnessDisplayName("hermes")).toBe("Hermes");
    expect(harnessNotInstalledMessage("Claude Code")).toBe(
      "Claude Code is not installed on this machine",
    );
  });
});

describe("isMissingExecutableError", () => {
  it("matches ENOENT code and common missing-binary messages", () => {
    expect(
      isMissingExecutableError(Object.assign(new Error("spawn claude"), { code: "ENOENT" })),
    ).toBe(true);
    expect(isMissingExecutableError(new Error("command not found: claude"))).toBe(
      true,
    );
    expect(isMissingExecutableError(new Error("posix_spawnp failed"))).toBe(true);
    expect(
      isMissingExecutableError(
        new Error("native PTY backend is unavailable: ENOENT: no such file", {
          cause: Object.assign(new Error("spawn"), { code: "ENOENT" }),
        }),
      ),
    ).toBe(true);
    expect(isMissingExecutableError(new Error("EACCES: permission denied"))).toBe(
      false,
    );
  });
});

describe("classifySpawnFailure", () => {
  it("classifies missing harness CLI with product copy", () => {
    const classified = classifySpawnFailure(
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
      "claude",
    );
    expect(classified.reason).toBe("cli-missing");
    expect(classified.message).toBe(
      "Claude Code is not installed on this machine",
    );
    expect(classified.journal).toContain("Claude Code");
    expect(classified.journal).toContain("PATH");
    expect(classified.journal.toLowerCase()).not.toContain("failed to spawn: enoent");
  });

  it("names every v1 harness by display name", () => {
    for (const [harness, name] of [
      ["claude", "Claude Code"],
      ["codex", "Codex"],
      ["grok", "Grok"],
      ["hermes", "Hermes"],
    ] as const) {
      const classified = classifySpawnFailure(
        Object.assign(new Error("not found"), { code: "ENOENT" }),
        harness,
      );
      expect(classified.message).toBe(`${name} is not installed on this machine`);
    }
  });

  it("keeps non-missing pre-ownership failures as spawn_failed, not stopped", () => {
    const classified = classifySpawnFailure(
      new Error("claude seat launch unresolvable: the seat's launch profile carries no argv"),
      "claude",
    );
    expect(classified.reason).toBe("spawn_failed");
    expect(classified.message).toBe("Claude Code failed to start");
    expect(classified.journal).toContain("no argv");
  });
});
