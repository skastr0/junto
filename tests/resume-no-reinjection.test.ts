import { describe, expect, it } from "vitest";
import { resolveManagedLaunchPlan } from "../src/shared/managed-terminal-launch";

const argvFor = (choices: Record<string, unknown>): readonly string[] => {
  const plan = resolveManagedLaunchPlan("claude" as never, choices as never) as {
    launch?: { argv?: readonly string[] };
  };
  return plan?.launch?.argv ?? [];
};

const doctrineIn = (argv: readonly string[]): string | undefined =>
  argv.find((a) => a.length > 200);

describe("resume must not re-inject the doctrine", () => {
  const base = { model: "default", effort: "xhigh", cwd: "/x" };

  it("a fresh spawn carries the doctrine", () => {
    const argv = argvFor({ ...base, injection: { seatBound: true, connected: true } });
    expect(doctrineIn(argv)).toBeTruthy();
    expect(argv).toContain("--append-system-prompt");
  });

  it("a resume carries --resume and NO system prompt", () => {
    // The resumed session already holds the doctrine in its own history. Adding
    // it again stacks kilobytes onto a fully restored context, which can cross
    // the harness auto-compaction threshold the moment the seat reopens and
    // destroy the very context the operator reopened to keep.
    const argv = argvFor({
      ...base,
      resumeId: "SID",
      injection: { seatBound: false, connected: false },
    });
    expect(argv).toContain("--resume");
    expect(argv).toContain("SID");
    expect(doctrineIn(argv)).toBeUndefined();
    expect(argv).not.toContain("--append-system-prompt");
  });
});
