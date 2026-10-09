/**
 * What main may tell the window about a machine send in flight: one closed
 * step, tied to the command that started it. The window decodes before it
 * reads; a payload that is anything else is refused.
 */
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { decodeMachineCommandProgress } from "../src/shared/machine-progress";

const step = {
  id: "send-01",
  event: { event: "machine-install", juntoHome: "/home/op/.junto", installRoot: "/home/op/.junto-install", step: "verified" },
};

describe("a step of a machine command in flight", () => {
  it("decodes with the id of the command it belongs to", () => {
    const decoded = decodeMachineCommandProgress(step);
    expect(Result.isSuccess(decoded)).toBe(true);
    expect(Result.getOrThrow(decoded)).toEqual(step);
  });

  it("refuses a step the installer does not have", () => {
    expect(Result.isFailure(decodeMachineCommandProgress({ ...step, event: { ...step.event, step: "rooted" } }))).toBe(true);
  });

  it("refuses anything riding along", () => {
    expect(Result.isFailure(decodeMachineCommandProgress({ ...step, secret: "value" }))).toBe(true);
    expect(Result.isFailure(decodeMachineCommandProgress({ ...step, event: { ...step.event, env: { TOKEN: "value" } } }))).toBe(true);
  });

  it("refuses a step that names no command", () => {
    expect(Result.isFailure(decodeMachineCommandProgress({ event: step.event }))).toBe(true);
    expect(Result.isFailure(decodeMachineCommandProgress({ ...step, id: "" }))).toBe(true);
    expect(Result.isFailure(decodeMachineCommandProgress({ ...step, id: "two words" }))).toBe(true);
  });
});
