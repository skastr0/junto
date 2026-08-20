import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CompletionEvidence,
  Passage,
  Task,
  TaskClaim,
  TaskProposal,
  Ticket,
  TICKET_OUTPUT_TAIL_MAX_BYTES,
} from "../src/shared/work-model";
import { taskItem } from "./helpers/task-fixtures";

// Additive pipeline fields on Task/CompletionEvidence. Legacy shapes must
// keep decoding untouched.

const seatId = `seat_${"1".repeat(64)}`;

const decodeTask = Schema.decodeUnknownResult(Task, { onExcessProperty: "error" });

describe("Task pipeline fields", () => {
  const fullTask = {
    ...taskItem("task-1", "Ship it", "working"),
    claimedBy: seatId,
    claims: [
      { id: "01C", text: "Security reviewed", severity: "hard", station: "sink-sec" },
    ],
    epoch: 1,
    journey: [
      {
        nodeId: "sink-build",
        enteredAt: "2026-08-20T10:00:00.000Z",
        epoch: 0,
        claimedBy: seatId,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "forwarded",
        next: "sink-review",
        emissionNote: "Built and unit-tested.",
      },
      {
        nodeId: "sink-review",
        enteredAt: "2026-08-20T11:00:00.000Z",
        epoch: 1,
      },
    ],
    holdUntil: "2026-08-20T11:05:00.000Z",
    boarding: [
      {
        checkId: "01OUT",
        side: "outbound",
        label: "tests",
        command: "bun run test",
        exitCode: 0,
        outputTail: "all green",
        at: "2026-08-20T10:59:00.000Z",
        epoch: 0,
      },
    ],
  };

  it("decodes and round-trips journey, epoch, holdUntil, boarding and claims", () => {
    const decoded = decodeTask(fullTask);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;

    expect(decoded.success.epoch).toBe(1);
    expect(decoded.success.journey?.[0]?.exit).toBe("forwarded");
    expect(decoded.success.journey?.[1]?.exitedAt).toBeUndefined();
    expect(decoded.success.boarding?.[0]?.exitCode).toBe(0);
    expect(decoded.success.claims?.[0]?.station).toBe("sink-sec");

    const encoded = Schema.encodeResult(Task)(decoded.success);
    expect(Result.isSuccess(encoded)).toBe(true);
    if (Result.isSuccess(encoded)) expect(encoded.success).toEqual(fullTask);
  });

  it("legacy task without any pipeline field still decodes", () => {
    expect(Result.isSuccess(decodeTask(taskItem("task-old", "Old work")))).toBe(true);
  });

  it.each([
    ["negative epoch", { epoch: -1 }],
    ["fractional epoch", { epoch: 0.5 }],
    ["unknown passage exit", {
      journey: [{ nodeId: "s", enteredAt: "t", epoch: 0, exit: "teleported" }],
    }],
    ["claim without station", {
      claims: [{ id: "01C", text: "x", severity: "hard" }],
    }],
    ["claim with empty station", {
      claims: [{ id: "01C", text: "x", severity: "soft", station: "" }],
    }],
  ] as const)("rejects %s", (_label, patch) => {
    expect(
      Result.isFailure(decodeTask({ ...taskItem("task-1", "Ship it"), ...patch })),
    ).toBe(true);
  });
});

describe("TaskClaim", () => {
  const decode = Schema.decodeUnknownResult(TaskClaim, { onExcessProperty: "error" });

  it("is a ClaimDef plus a station address", () => {
    const decoded = decode({
      id: "01C",
      text: "Contract verified",
      severity: "hard",
      station: "sink-review",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("rejects a taxonomy-ish extra field", () => {
    expect(
      Result.isFailure(
        decode({
          id: "01C",
          text: "x",
          severity: "hard",
          station: "s",
          tags: ["backend"],
        }),
      ),
    ).toBe(true);
  });
});

describe("CompletionEvidence claim responses and waivers", () => {
  const decode = Schema.decodeUnknownResult(CompletionEvidence, {
    onExcessProperty: "error",
  });

  it("keeps legacy artifacts/git decoding without the new fields", () => {
    const decoded = decode({
      artifacts: [{ artifactId: "a1", nodeId: "n1" }],
      git: { commits: ["abc123"] },
    });
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("decodes responses and claimWaivers alongside legacy evidence", () => {
    const decoded = decode({
      artifacts: [],
      responses: [
        { claimId: "01C", response: "Verified by reading the diff", refs: ["r1"] },
        { claimId: "01D", response: "Done" },
      ],
      claimWaivers: [{ claimId: "01E", reason: "Station unreachable after fork" }],
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.responses?.length).toBe(2);
    expect(decoded.success.claimWaivers?.[0]?.claimId).toBe("01E");
  });

  it.each([
    ["empty waiver reason", { artifacts: [], claimWaivers: [{ claimId: "c", reason: "" }] }],
    ["empty response text", { artifacts: [], responses: [{ claimId: "c", response: "" }] }],
    ["response without claimId", { artifacts: [], responses: [{ response: "x" }] }],
  ] as const)("rejects %s", (_label, input) => {
    expect(Result.isFailure(decode(input))).toBe(true);
  });
});

describe("Ticket", () => {
  const decode = Schema.decodeUnknownResult(Ticket, { onExcessProperty: "error" });
  const base = {
    checkId: "01OUT",
    side: "inbound",
    label: "typecheck",
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
        decode({ ...base, outputTail: "x".repeat(TICKET_OUTPUT_TAIL_MAX_BYTES) }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({ ...base, outputTail: "x".repeat(TICKET_OUTPUT_TAIL_MAX_BYTES + 1) }),
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

describe("Passage", () => {
  const decode = Schema.decodeUnknownResult(Passage, { onExcessProperty: "error" });

  it("requires only nodeId, enteredAt and epoch", () => {
    expect(
      Result.isSuccess(
        decode({ nodeId: "s", enteredAt: "2026-08-20T10:00:00.000Z", epoch: 0 }),
      ),
    ).toBe(true);
  });

  it("accepts every exit word", () => {
    for (const exit of ["forwarded", "closed", "rejected-back"]) {
      expect(
        Result.isSuccess(
          decode({ nodeId: "s", enteredAt: "t", epoch: 0, exit }),
        ),
      ).toBe(true);
    }
  });
});

describe("TaskProposal claims", () => {
  it("carries station-addressed claims through the shared authoring fields", () => {
    const decoded = Schema.decodeUnknownResult(TaskProposal, {
      onExcessProperty: "error",
    })({
      id: "prop-1",
      state: "pending",
      brief: {
        messageId: "m1",
        role: "agent",
        parts: [{ kind: "text", text: "Proposed follow-up" }],
      },
      proposedBy: { seatId, canvasName: "factory", nodeId: "agent-1" },
      claims: [{ id: "01C", text: "Verified", severity: "soft", station: "sink-qa" }],
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.claims?.[0]?.station).toBe("sink-qa");
  });
});
