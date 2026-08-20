import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  BOARDING_TIMEOUT_EXIT_CODE,
  type BoardingCheckPlan,
} from "../src/shared/boarding";
import { runBoardingCheck } from "../src/cli/commands/board";

const check = (command: string): BoardingCheckPlan => ({
  checkId: "c1",
  side: "outbound",
  label: "check",
  command,
});

describe("runBoardingCheck", () => {
  it("captures exit 0 and the command output", async () => {
    const run = await Effect.runPromise(
      runBoardingCheck(check("echo green"), 30_000),
    );
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("green");
  });

  it("captures a non-zero exit and stderr", async () => {
    const run = await Effect.runPromise(
      runBoardingCheck(check("echo bad 1>&2; exit 3"), 30_000),
    );
    expect(run.exitCode).toBe(3);
    expect(run.output).toContain("bad");
  });

  it("abandons a check that outruns its wall clock", async () => {
    const run = await Effect.runPromise(runBoardingCheck(check("sleep 30"), 200));
    expect(run.exitCode).toBe(BOARDING_TIMEOUT_EXIT_CODE);
    expect(run.timedOut).toBe(true);
    expect(run.output).toContain("timed out");
  });
});
