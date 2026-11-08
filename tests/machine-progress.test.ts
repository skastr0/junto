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
  it("admits copy counts and refuses invalid totals or invented completion", () => {
    const event = { event: "machine-copy", copiedBytes: 25, totalBytes: 69, state: "copying" };
    expect(Result.isSuccess(decodeMachineCommandProgress({ id: "send-01", event }))).toBe(true);
    for (const bad of [{ copiedBytes: -1 }, { copiedBytes: 70 }, { totalBytes: 0 }, { copiedBytes: 0.5 }, { state: "copied" }, { token: "secret" }]) {
      expect(Result.isFailure(decodeMachineCommandProgress({ id: "send-01", event: { ...event, ...bad } }))).toBe(true);
    }
    expect(Result.isSuccess(decodeMachineCommandProgress({ id: "send-01", event: { ...event, copiedBytes: 69, state: "copied" } }))).toBe(true);
  });
  it("admits download counts separately and refuses oversized or invented completion", () => {
    const event = { event: "machine-download", downloadedBytes: 25, totalBytes: 69, state: "downloading" };
    expect(Result.isSuccess(decodeMachineCommandProgress({ id: "send-01", event }))).toBe(true);
    for (const bad of [{ downloadedBytes: -1 }, { downloadedBytes: 70 }, { totalBytes: 300_000_000 }, { downloadedBytes: 0.5 }, { state: "downloaded" }, { origin: "https://example.invalid" }]) {
      expect(Result.isFailure(decodeMachineCommandProgress({ id: "send-01", event: { ...event, ...bad } }))).toBe(true);
    }
    expect(Result.isSuccess(decodeMachineCommandProgress({ id: "send-01", event: { ...event, downloadedBytes: 69, state: "downloaded" } }))).toBe(true);
  });
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
