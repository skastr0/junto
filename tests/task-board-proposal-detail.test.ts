import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { proposalAsDisplayTask } from "../src/renderer/components/work/TaskBoard";
import { ActorSeatId } from "../src/shared/actor-seat";
import { taskBrief, taskMediaParts } from "../src/shared/task";

const seat = (hex: string) =>
  Schema.decodeUnknownSync(ActorSeatId)(`seat_${hex}`);

describe("proposalAsDisplayTask", () => {
  it("maps full proposal authoring fields onto the task display shape", () => {
    const display = proposalAsDisplayTask({
      id: "proposal-1",
      state: "pending",
      brief: {
        messageId: "brief-1",
        role: "user",
        parts: [
          { kind: "text", text: "Ship proposal detail" },
          {
            kind: "raw",
            bytesBase64: "aGVsbG8=",
            mediaType: "image/png",
          },
        ],
        taskId: "proposal-1",
        contextId: "Vellumcommand",
      },
      proposedBy: {
        seatId: seat("a".repeat(64)),
        canvasName: "factory",
        nodeId: "agent-01",
      },
      metadata: {
        title: "Proposal task details",
        details: "I can't open proposal details.",
        workRole: "frontend",
      },
      reason: "parity with normal tasks",
      dependsOn: ["task-dep-1"],
      finishCriteria: {
        description: "same display as a normal task",
        git: { minCommits: 1 },
      },
    });

    expect(display.id).toBe("proposal-1");
    expect(display.state).toBe("submitted");
    expect(taskBrief(display)).toBe("Ship proposal detail");
    expect(display.metadata).toEqual({
      title: "Proposal task details",
      details: "I can't open proposal details.",
      workRole: "frontend",
    });
    expect(display.reason).toBe("parity with normal tasks");
    expect(display.dependsOn).toEqual(["task-dep-1"]);
    expect(display.finishCriteria).toEqual({
      description: "same display as a normal task",
      git: { minCommits: 1 },
    });
    expect(taskMediaParts(display)).toHaveLength(1);
    expect(taskMediaParts(display)[0]?.mediaType).toBe("image/png");
  });

  it("omits empty optional arms so Task schema stays clean", () => {
    const display = proposalAsDisplayTask({
      id: "proposal-2",
      state: "pending",
      brief: {
        messageId: "brief-2",
        role: "user",
        parts: [{ kind: "text", text: "x" }],
        taskId: "proposal-2",
        contextId: "Vellumcommand",
      },
      proposedBy: {
        seatId: seat("b".repeat(64)),
        canvasName: "factory",
        nodeId: "operator",
      },
    });

    expect(display.metadata).toBeUndefined();
    expect(display.reason).toBeUndefined();
    expect(display.dependsOn).toBeUndefined();
    expect(display.finishCriteria).toBeUndefined();
  });
});
