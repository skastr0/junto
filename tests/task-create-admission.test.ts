import { describe, expect, it } from "vitest";
import {
  defaultTaskAdmission,
  parseTaskWait,
  taskAdmissionChoices,
} from "../src/renderer/components/work/task-create-admission";

describe("task creation admission", () => {
  it("inherits Who starts it from the board floor", () => {
    expect(defaultTaskAdmission("auto")).toBe("auto");
    expect(defaultTaskAdmission("approval")).toBe("approval");
    expect(defaultTaskAdmission("operator")).toBe("operator");
  });

  it("offers every admission choice", () => {
    const choices = taskAdmissionChoices("approval");
    expect(choices.map(({ value }) => value)).toEqual([
      "auto",
      "approval",
      "operator",
    ]);
    expect(choices.every((choice) => !choice.disabled)).toBe(true);
  });

  it("parses spoken waits and enforces the work-plane ceiling", () => {
    expect(parseTaskWait("")).toEqual({ ok: true, ms: undefined });
    expect(parseTaskWait("12h")).toEqual({ ok: true, ms: 43_200_000 });
    expect(parseTaskWait("91d")).toEqual({
      ok: false,
      message: "Wait duration cannot exceed 90 days.",
    });
    expect(parseTaskWait("later").ok).toBe(false);
  });
});
