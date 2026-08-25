import { describe, expect, it } from "vitest";
import {
  defaultTaskAdmission,
  parseTaskHold,
  taskAdmissionChoices,
} from "../src/renderer/components/work/task-create-admission";

describe("task creation admission", () => {
  it("defaults to approval unless the sink floor is operator-owned", () => {
    expect(defaultTaskAdmission("auto")).toBe("operator-gated");
    expect(defaultTaskAdmission("operator-gated")).toBe("operator-gated");
    expect(defaultTaskAdmission("operator-owned")).toBe("operator-owned");
  });

  it("disables every choice that would loosen the named sink floor", () => {
    const gated = taskAdmissionChoices("operator-gated");
    expect(gated.map(({ value, disabled }) => [value, disabled])).toEqual([
      ["auto", true],
      ["operator-gated", false],
      ["operator-owned", false],
    ]);
    expect(gated[0]?.reason).toContain("sink floor");
    expect(gated[0]?.reason).toContain("Waits for my approval");

    const owned = taskAdmissionChoices("operator-owned");
    expect(owned.map(({ disabled }) => disabled)).toEqual([true, true, false]);
  });

  it("parses spoken holds and enforces the work-plane ceiling", () => {
    expect(parseTaskHold("")).toEqual({ ok: true, ms: undefined });
    expect(parseTaskHold("12h")).toEqual({ ok: true, ms: 43_200_000 });
    expect(parseTaskHold("91d")).toEqual({
      ok: false,
      message: "Hold duration cannot exceed 90 days.",
    });
    expect(parseTaskHold("later").ok).toBe(false);
  });
});
