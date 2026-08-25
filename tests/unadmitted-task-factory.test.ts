import { describe, expect, it } from "vitest";
import { PIPELINE_ADMITTED_METADATA_KEY } from "../src/shared/claims";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";
import {
  DEFAULT_UNADMITTED_ADMISSION,
  taskIsUnpromotedSubmitted,
  unadmittedTask,
} from "./helpers/unadmitted-task-fixtures";

describe("unadmitted task factory", () => {
  it("mints a submitted unclaimed unpromoted Task with operator-gated overlay", () => {
    const raisedBy = actorRefFixture("agent-1");
    const fixture = unadmittedTask({
      id: "task-1",
      brief: "Ship unification",
      details: "Pending proposals become real tasks.",
      raisedBy,
      reason: "wave-1",
      dependsOn: ["task-0"],
      finishCriteria: { description: "tests green" },
      claims: [
        {
          id: "c1",
          text: "Verified",
          severity: "soft",
          station: "qa",
        },
      ],
    });

    expect(fixture.admission).toBe(DEFAULT_UNADMITTED_ADMISSION);
    expect(fixture.raisedBy).toEqual(raisedBy);
    expect(taskIsUnpromotedSubmitted(fixture.task)).toBe(true);
    expect(fixture.task.id).toBe("task-1");
    expect(fixture.task.history[0]?.taskId).toBe("task-1");
    expect(fixture.task.metadata).toEqual({
      details: "Pending proposals become real tasks.",
    });
    expect(fixture.task.metadata?.[PIPELINE_ADMITTED_METADATA_KEY]).toBeUndefined();
    expect(fixture.task.dependsOn).toEqual(["task-0"]);
    expect(fixture.task.finishCriteria).toEqual({ description: "tests green" });
    expect(fixture.task.claims?.[0]?.id).toBe("c1");
    expect(fixture.task.holdUntil).toBeUndefined();
  });

  it("stamps holdUntil when asked and keeps explicit auto as the overlay", () => {
    const fixture = unadmittedTask({
      id: "task-2",
      brief: "Immediate",
      details: "Requester asked auto.",
      admission: "auto",
      holdUntil: "2026-08-26T00:00:00.000Z",
    });
    expect(fixture.admission).toBe("auto");
    expect(fixture.task.holdUntil).toBe("2026-08-26T00:00:00.000Z");
    expect(taskIsUnpromotedSubmitted(fixture.task)).toBe(true);
  });
});
