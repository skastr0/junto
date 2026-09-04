import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  CHECK_TIMEOUT_EXIT_CODE,
  type CheckPlanItem,
} from "../src/shared/checks";
import { runCheck } from "../src/cli/commands/board";

const check = (command: string): CheckPlanItem => ({
  checkId: "c1",
  side: "outgoing",
  label: "check",
  command,
});

describe("runCheck", () => {
  it("captures exit 0 and the command output", async () => {
    const run = await Effect.runPromise(
      runCheck(check("echo green"), 30_000),
    );
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("green");
  });

  it("captures a non-zero exit and stderr", async () => {
    const run = await Effect.runPromise(
      runCheck(check("echo bad 1>&2; exit 3"), 30_000),
    );
    expect(run.exitCode).toBe(3);
    expect(run.output).toContain("bad");
  });

  it("abandons a check that outruns its wall clock", async () => {
    const run = await Effect.runPromise(runCheck(check("sleep 30"), 200));
    expect(run.exitCode).toBe(CHECK_TIMEOUT_EXIT_CODE);
    expect(run.timedOut).toBe(true);
    expect(run.output).toContain("timed out");
  });
});
