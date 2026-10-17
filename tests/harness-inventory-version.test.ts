import { describe, expect, it } from "vitest";
import { parseHarnessVersion } from "../src/main/junto/term/templates/harness-inventory";

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
