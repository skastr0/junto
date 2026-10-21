import { describe, expect, it } from "vitest";
import { parseHarnessVersion, versionProbeOutcome } from "../src/main/junto/term/templates/harness-inventory";

describe("parseHarnessVersion", () => {
  it.each([
    ["2.1.300 (Claude Code)\n", "2.1.300"],
    ["codex-cli 0.162.1", "0.162.1"],
    ["cursor-agent 2026.08.11-1a2b3c", "2026.08.11-1a2b3c"],
    ["pi v0.5\n", "0.5"],
  ])("reads %j as %j", (output, version) => {
    expect(parseHarnessVersion(output)).toBe(version);
  });

  it("answers nothing when the output has no version", () => {
    expect(parseHarnessVersion("usage: tool [options]")).toBeUndefined();
  });

  it("bounds what it keeps", () => {
    expect(parseHarnessVersion(`1.0.0-${"a".repeat(200)}`)?.length).toBe(64);
  });
});

describe("versionProbeOutcome", () => {
  it("reads the version off a run that printed one", () => {
    expect(versionProbeOutcome({ ok: true, stdout: "2.1.302 (Claude Code)\n" })).toEqual({ version: "2.1.302" });
  });

  it("names why a run gave none: timeout, could not start, exited, or printed none", () => {
    expect(versionProbeOutcome({ ok: false, stdout: "", error: "adapter command timed out after 5000ms" }))
      .toMatchObject({ reason: "timeout" });
    // The detail is scrubbed of this process's environment values, and a
    // launch through env(1) leaves `_=/usr/bin/env`, so the path names no
    // real file.
    expect(versionProbeOutcome({ ok: false, stdout: "", error: "spawn /missing/bin/claude ENOENT" }))
      .toMatchObject({ reason: "spawn", detail: "spawn /missing/bin/claude ENOENT" });
    expect(versionProbeOutcome({ ok: false, stdout: "", error: "/usr/bin/env: 'node': No such file or directory" }))
      .toMatchObject({ reason: "exited" });
    expect(versionProbeOutcome({ ok: true, stdout: "Welcome to Claude Code\n" }))
      .toEqual({ reason: "unparsed", detail: "Welcome to Claude Code" });
  });

  it("keeps the detail short", () => {
    const miss = versionProbeOutcome({ ok: false, stdout: "", error: "x".repeat(500) });
    expect("detail" in miss && miss.detail.length).toBe(160);
  });
});
