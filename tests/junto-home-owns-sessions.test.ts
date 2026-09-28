import { describe, expect, it } from "vitest";
import { shouldAvoidSharedHarnessResume } from "../src/main/junto/term/managed-spawn-plan";

describe("isolated JUNTO_HOME that owns its sessions", () => {
  it("still refuses shared resume by default", () => {
    expect(shouldAvoidSharedHarnessResume("/tmp/junto-iso", undefined)).toBe(true);
    expect(shouldAvoidSharedHarnessResume("/tmp/junto-iso", "0")).toBe(true);
  });

  it("resumes when the tree declares every pin on it its own", () => {
    expect(shouldAvoidSharedHarnessResume("/tmp/junto-iso", "1")).toBe(false);
  });

  it("the production home never isolates", () => {
    expect(shouldAvoidSharedHarnessResume("", "")).toBe(false);
  });
});
