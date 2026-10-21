/**
 * `junto task check`: the results a seat reports, from flags or JSON, and
 * the checks-unmet refusal a finish prints, as main words it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { checkResultsOf } from "../src/cli/commands/task";
import { WireError } from "../src/cli/core/errors";
import { renderFailureEnvelope } from "../src/cli/core/output";
import { refusalError } from "../src/shared/resource-command";
import { taskRefusalMessage } from "../src/shared/task-machine";
import { CHECK_OUTPUT_TAIL_MAX } from "../src/shared/task-model";

const results = (outgoing: ReadonlyArray<string>, incoming: ReadonlyArray<string>, json?: string) =>
  Effect.runPromiseExit(checkResultsOf({ outgoing, incoming, results: Option.fromNullishOr(json) }));

const failedAt = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as { error: { path?: string } }).error.path : "succeeded";

describe("task check results", () => {
  it("reads each flag as one result on its side, with no output", async () => {
    const exit = await results(["tests=0", "a=b=1"], ["e2e=-1"]);
    expect(exit).toEqual(Exit.succeed([
      { checkId: "tests", side: "outgoing", exitCode: 0, outputTail: "" },
      // The last = ends the check id.
      { checkId: "a=b", side: "outgoing", exitCode: 1, outputTail: "" },
      { checkId: "e2e", side: "incoming", exitCode: -1, outputTail: "" },
    ]));
  });

  it("refuses a flag with no exit code, and flags beside --results or neither", async () => {
    expect(failedAt(await results(["tests=green"], []))).toBe("outgoing");
    expect(failedAt(await results([], ["tests"]))).toBe("incoming");
    expect(failedAt(await results([], []))).toBe("results");
    expect(failedAt(await results(["tests=0"], [], "[]"))).toBe("results");
  });

  it("reads --results from a file, keeping each output's last characters, not bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junto-task-check-"));
    try {
      const file = join(dir, "checks.json");
      // Each é is one character and two UTF-8 bytes: a byte cut would keep half as many.
      const output = `${"é".repeat(CHECK_OUTPUT_TAIL_MAX)}end`;
      writeFileSync(file, JSON.stringify([{ checkId: "e2e", side: "incoming", exitCode: 1, outputTail: output }]));
      const exit = await results([], [], `@${file}`);
      if (Exit.isFailure(exit)) throw new Error("expected results");
      expect(exit.value[0]!.outputTail).toHaveLength(CHECK_OUTPUT_TAIL_MAX);
      expect(exit.value[0]!.outputTail.endsWith("éend")).toBe(true);
      expect(failedAt(await results([], [], '[{"checkId":"e2e","side":"sideways","exitCode":1,"outputTail":""}]'))).not.toBe("succeeded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a finish refused checks-unmet", () => {
  it("prints the red checks and the ones not run", () => {
    // Main's error body for the refusal, as resource-ipc builds it, then as the CLI prints it.
    const detail = { kind: "checks-unmet" as const, red: ["lint"], missing: ["e2e", "docs"] };
    const body = refusalError({ reason: "invalid_input", message: taskRefusalMessage(detail), expected: detail });
    const printed = JSON.parse(renderFailureEnvelope("task finish", new WireError({ type: body.type, message: body.message, details: body.details })));
    expect(printed.ok).toBe(false);
    expect(printed.error.message).toBe(
      "Required checks are not green at this epoch (red: lint; not run: e2e, docs). Run them and report each with task check",
    );
    expect(printed.error.details.expected).toEqual(detail);
  });
});
