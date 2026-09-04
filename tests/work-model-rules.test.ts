import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CheckResult,
  CHECK_OUTPUT_TAIL_MAX_BYTES,
  CompletionEvidence,
  Task,
  TaskRule,
  Visit,
} from "../src/shared/work-model";
import { taskItem } from "./helpers/task-fixtures";

// Canonical Task fields: rules, visits, epoch, waitUntil, checkResults, and
// completionEvidence claims/waivers.

const seatId = `seat_${"1".repeat(64)}`;

const decodeTask = Schema.decodeUnknownResult(Task, {
  onExcessProperty: "error",
});

describe("Task rules, visits, and check results", () => {
  const fullTask = {
    ...taskItem("task-1", "Ship it", "working"),
    claimedBy: seatId,
    rules: [{ id: "01R", text: "Security reviewed", board: "sec" }],
    epoch: 1,
    visits: [
      {
        board: "build",
        enteredAt: "2026-08-20T10:00:00.000Z",
        epoch: 0,
        claimedBy: seatId,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "sent-on",
        next: "review",
        handoffNote: "Built and unit-tested.",
      },
      {
        board: "review",
        enteredAt: "2026-08-20T11:00:00.000Z",
        epoch: 1,
      },
    ],
    waitUntil: "2026-08-20T11:05:00.000Z",
    checkResults: [
      {
        checkId: "01OUT",
        side: "outgoing",
        command: "bun run test",
        exitCode: 0,
        outputTail: "all green",
        at: "2026-08-20T10:59:00.000Z",
        epoch: 0,
      },
    ],
  };

  it("decodes and round-trips rules, visits, epoch, waitUntil, and checkResults", () => {
    const decoded = decodeTask(fullTask);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;

    expect(decoded.success.epoch).toBe(1);
    expect(decoded.success.visits?.[0]?.exit).toBe("sent-on");
    expect(decoded.success.visits?.[1]?.exitedAt).toBeUndefined();
    expect(decoded.success.checkResults?.[0]?.exitCode).toBe(0);
    expect(decoded.success.rules?.[0]?.board).toBe("sec");

    const encoded = Schema.encodeResult(Task)(decoded.success);
    expect(Result.isSuccess(encoded)).toBe(true);
    if (Result.isSuccess(encoded)) expect(encoded.success).toEqual(fullTask);
  });

  it("task without any rule, visit, or check field still decodes", () => {
    expect(
      Result.isSuccess(decodeTask(taskItem("task-old", "Old work"))),
    ).toBe(true);
  });

  it.each([
    ["negative epoch", { epoch: -1 }],
    ["fractional epoch", { epoch: 0.5 }],
    [
      "unknown visit exit",
      { visits: [{ board: "s", enteredAt: "t", epoch: 0, exit: "teleported" }] },
    ],
    ["task rule without board", { rules: [{ id: "01R", text: "x" }] }],
    ["task rule with empty board", { rules: [{ id: "01R", text: "x", board: "" }] }],
  ] as const)("rejects %s", (_label, patch) => {
    expect(
      Result.isFailure(decodeTask({ ...taskItem("task-1", "Ship it"), ...patch })),
    ).toBe(true);
  });
});

describe("TaskRule", () => {
  const decode = Schema.decodeUnknownResult(TaskRule, {
    onExcessProperty: "error",
  });

  it("is a Rule plus a board address", () => {
    const decoded = decode({
      id: "01R",
      text: "Contract verified",
      board: "review",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("rejects a taxonomy-ish extra field", () => {
    expect(
      Result.isFailure(
        decode({
          id: "01R",
          text: "x",
          board: "s",
          tags: ["backend"],
        }),
      ),
    ).toBe(true);
  });
});

describe("CompletionEvidence claims and waivers", () => {
  const decode = Schema.decodeUnknownResult(CompletionEvidence, {
    onExcessProperty: "error",
  });

  it("keeps artifacts/git decoding without claims or waivers", () => {
    const decoded = decode({
      artifacts: [{ artifactId: "a1", nodeId: "n1" }],
      git: { commits: ["abc123"] },
    });
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("decodes claims and waivers alongside the evidence", () => {
    const decoded = decode({
      artifacts: [],
      claims: [
        { ruleId: "01R", text: "Verified by reading the diff", refs: ["r1"] },
        { ruleId: "01S", text: "Done" },
      ],
      waivers: [{ ruleId: "01T", reason: "Board unreachable after fork" }],
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.claims?.length).toBe(2);
    expect(decoded.success.waivers?.[0]?.ruleId).toBe("01T");
  });

  it.each([
    [
      "empty waiver reason",
      { artifacts: [], waivers: [{ ruleId: "r", reason: "" }] },
    ],
    ["empty claim text", { artifacts: [], claims: [{ ruleId: "r", text: "" }] }],
    ["claim without ruleId", { artifacts: [], claims: [{ text: "x" }] }],
  ] as const)("rejects %s", (_label, input) => {
    expect(Result.isFailure(decode(input))).toBe(true);
  });
});

describe("CheckResult", () => {
  const decode = Schema.decodeUnknownResult(CheckResult, {
    onExcessProperty: "error",
  });
  const base = {
    checkId: "01OUT",
    side: "incoming",
    command: "bun run typecheck",
    exitCode: 2,
    outputTail: "error TS2345",
    at: "2026-08-20T10:00:00.000Z",
    epoch: 0,
  };

  it("decodes a red check result", () => {
    expect(Result.isSuccess(decode(base))).toBe(true);
  });

  it("caps outputTail at the shared limit", () => {
    expect(
      Result.isSuccess(
        decode({ ...base, outputTail: "x".repeat(CHECK_OUTPUT_TAIL_MAX_BYTES) }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({
          ...base,
          outputTail: "x".repeat(CHECK_OUTPUT_TAIL_MAX_BYTES + 1),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["unknown side", { side: "sideways" }],
    ["fractional exit code", { exitCode: 0.5 }],
    ["negative epoch", { epoch: -1 }],
  ] as const)("rejects %s", (_label, patch) => {
    expect(Result.isFailure(decode({ ...base, ...patch }))).toBe(true);
  });
});

describe("Visit", () => {
  const decode = Schema.decodeUnknownResult(Visit, {
    onExcessProperty: "error",
  });

  it("requires only board, enteredAt and epoch", () => {
    expect(
      Result.isSuccess(
        decode({ board: "s", enteredAt: "2026-08-20T10:00:00.000Z", epoch: 0 }),
      ),
    ).toBe(true);
  });

  it("accepts every exit word", () => {
    for (const exit of ["sent-on", "completed", "sent-back"]) {
      expect(
        Result.isSuccess(decode({ board: "s", enteredAt: "t", epoch: 0, exit })),
      ).toBe(true);
    }
  });
});

describe("approval-admission task", () => {
  it("carries admission and raisedBy through the shared authoring fields", () => {
    const decoded = Schema.decodeUnknownResult(Task, {
      onExcessProperty: "error",
    })({
      ...taskItem("task-approval-1", "Follow-up awaiting approval"),
      admission: "approval",
      raisedBy: { seatId, canvasName: "factory", nodeId: "agent-1" },
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.admission).toBe("approval");
    expect(decoded.success.raisedBy?.nodeId).toBe("agent-1");
  });
});
