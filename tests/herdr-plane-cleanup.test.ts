import { describe, expect, it } from "vitest";
import { runHerdrCleanupSteps } from "../src/main/vellum/herdr/plane";

describe("Herdr plane cleanup fan-out", () => {
  it("runs every finalizer component when an earlier component throws", () => {
    const calls: string[] = [];

    expect(() =>
      runHerdrCleanupSteps([
        () => {
          calls.push("streams");
          throw new Error("stream cleanup failed");
        },
        () => calls.push("mirrors"),
        () => calls.push("service-map"),
      ]),
    ).not.toThrow();

    expect(calls).toEqual(["streams", "mirrors", "service-map"]);
  });
});
