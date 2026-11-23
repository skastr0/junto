import { describe, expect, it } from "vitest";
import { provideThreadKey, runThreadKey } from "../src/window/lib/thread-keys";

describe("thread keys", () => {
  it("passes the key while no surface answers it", () => {
    expect(runThreadKey("threads.quick")).toBe(false);
  });

  it("runs the surface in front, and the one under it again once that lets go", () => {
    const calls: string[] = [];
    const canvas = provideThreadKey("threads.quick", () => {
      calls.push("canvas");
    });
    const global = provideThreadKey("threads.quick", () => {
      calls.push("threads");
    });
    expect(runThreadKey("threads.quick")).toBe(true);
    global();
    expect(runThreadKey("threads.quick")).toBe(true);
    canvas();
    expect(runThreadKey("threads.quick")).toBe(false);
    expect(calls).toEqual(["threads", "canvas"]);
  });

  it("passes the key when the run had nothing to do, and lets go once", () => {
    const stop = provideThreadKey("threads.quick", () => false);
    expect(runThreadKey("threads.quick")).toBe(false);
    stop();
    stop();
    expect(runThreadKey("threads.quick")).toBe(false);
  });
});
