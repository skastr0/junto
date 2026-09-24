import { describe, expect, it } from "vitest";
import {
  classifySpawnFailure,
  harnessDisplayName,
  harnessNotInstalledMessage,
  isMissingExecutableError,
  LaunchRefusedError,
  launchRefusalCopy,
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

  it("keeps non-missing pre-ownership failures as spawn_failed and names the raw reason", () => {
    const classified = classifySpawnFailure(
      new Error("Prime Agent daemon exited during startup\nstack line"),
      "claude",
    );
    expect(classified.reason).toBe("spawn_failed");
    expect(classified.message).toBe(
      "Claude Code could not start: Prime Agent daemon exited during startup",
    );
    expect(classified.journal).toContain("stack line");
  });

  it("shows the plain refusal reason, never a bare failed to start", () => {
    const missingFolder = classifySpawnFailure(
      new LaunchRefusedError({
        operatorReason: launchRefusalCopy.folderMissing("~/Projects/gone"),
        detail: "working directory is not a usable directory: /Users/op/Projects/gone",
      }),
      "codex",
    );
    expect(missingFolder).toMatchObject({
      reason: "spawn_failed",
      message: "Codex could not start: the folder ~/Projects/gone does not exist",
    });
    expect(missingFolder.journal).toContain("/Users/op/Projects/gone");

    const noArgv = classifySpawnFailure(
      new LaunchRefusedError({
        operatorReason: launchRefusalCopy.launchIncomplete,
        detail: "claude seat launch unresolvable: the seat's launch profile carries no argv",
      }),
      "claude",
    );
    expect(noArgv.message).toBe(
      "Claude Code could not start: its launch settings are incomplete",
    );
    expect(noArgv.journal).toContain("no argv");
  });

  it("classifies a refused launch by its own flag, not by regex on the detail", () => {
    const binary = new LaunchRefusedError({
      operatorReason: 'the harness binary "codex" was not found',
      detail: 'codex seat launch unresolvable: the harness binary "codex" was not found on the seat PATH',
      missingExecutable: true,
    });
    expect(isMissingExecutableError(binary)).toBe(true);
    expect(classifySpawnFailure(binary, "codex").message).toBe(
      "Codex is not installed on this machine",
    );

    // A folder refusal whose detail happens to say "not found" stays a folder problem.
    const folder = new LaunchRefusedError({
      operatorReason: launchRefusalCopy.folderMissing("/srv/not found"),
      detail: "working directory is not a usable directory: /srv/not found",
    });
    expect(isMissingExecutableError(folder)).toBe(false);
    expect(classifySpawnFailure(folder, "codex").reason).toBe("spawn_failed");
  });

  it("never writes a middle dot into operator copy", () => {
    const copies = [
      launchRefusalCopy.noFolder,
      launchRefusalCopy.folderMissing("~/x"),
      launchRefusalCopy.notAFolder("~/x"),
      launchRefusalCopy.launchIncomplete,
    ];
    for (const copy of copies) expect(copy).not.toContain("\u00b7");
  });
});
