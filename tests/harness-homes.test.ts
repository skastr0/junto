import { describe, expect, it } from "vitest";
import { harnessApplyRoot } from "../src/main/vellum/plugin-install/harness-homes";

describe("harnessApplyRoot", () => {
  it("maps fleet targets under home", () => {
    expect(harnessApplyRoot("/home/op", "claude-code")).toBe(
      "/home/op/.claude",
    );
    expect(harnessApplyRoot("/home/op/", "codex-cli")).toBe(
      "/home/op/.codex",
    );
    expect(harnessApplyRoot("/Users/x", "grok")).toBe("/Users/x/.grok");
    expect(harnessApplyRoot("/Users/x", "hermes")).toBe("/Users/x/.hermes");
  });
});
