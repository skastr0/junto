import { describe, expect, it } from "vitest";
import {
  OperatorInterlock,
  OPERATOR_INPUT_LATCH_MS,
  OPERATOR_RESIZE_LATCH_MS,
} from "../src/main/vellum-command/term/drive/operator-interlock";

describe("OperatorInterlock", () => {
  it("flushes nested holds only after each owner releases", () => {
    const interlock = new OperatorInterlock(() => 1_000);
    const writes: string[] = [];
    const outerRelease = interlock.beginHold("binding");
    const innerRelease = interlock.beginHold("binding");

    expect(interlock.holdWrite("binding", { replay: () => writes.push("first") })).toBe(true);
    expect(interlock.holdWrite("binding", { replay: () => writes.push("second") })).toBe(true);

    outerRelease();
    expect(interlock.holding("binding")).toBe(true);
    expect(interlock.heldCount("binding")).toBe(2);
    expect(writes).toEqual([]);

    innerRelease();
    expect(interlock.holding("binding")).toBe(false);
    expect(interlock.heldCount("binding")).toBe(0);
    expect(writes).toEqual(["first", "second"]);
  });

  it("does not let a stale release close a replacement binding hold", () => {
    const interlock = new OperatorInterlock(() => 1_000);
    const writes: string[] = [];
    const staleRelease = interlock.beginHold("binding");

    expect(interlock.holdWrite("binding", { replay: () => writes.push("stale") })).toBe(true);
    interlock.dropBinding("binding");

    const freshRelease = interlock.beginHold("binding");
    expect(interlock.holdWrite("binding", { replay: () => writes.push("fresh") })).toBe(true);
    staleRelease();

    expect(interlock.holding("binding")).toBe(true);
    expect(interlock.heldCount("binding")).toBe(1);
    expect(writes).toEqual([]);

    freshRelease();
    expect(writes).toEqual(["fresh"]);
  });

  it("makes each returned release closure idempotent", () => {
    const interlock = new OperatorInterlock(() => 1_000);
    const writes: string[] = [];
    const release = interlock.beginHold("binding");

    expect(interlock.holdWrite("binding", { replay: () => writes.push("once") })).toBe(true);
    release();
    release();

    expect(interlock.holding("binding")).toBe(false);
    expect(interlock.heldCount("binding")).toBe(0);
    expect(writes).toEqual(["once"]);
  });

  it("increments inputVersion for every input, including held input, and resets it", () => {
    const interlock = new OperatorInterlock(() => 1_000);

    expect(interlock.inputVersion("binding")).toBe(0);
    interlock.noteInput("binding");
    interlock.noteInput("binding");
    expect(interlock.inputVersion("binding")).toBe(2);

    const release = interlock.beginHold("binding");
    interlock.noteInput("binding");
    expect(interlock.inputVersion("binding")).toBe(3);
    release();

    interlock.dropBinding("binding");
    expect(interlock.inputVersion("binding")).toBe(0);
    interlock.noteInput("binding");
    expect(interlock.inputVersion("binding")).toBe(1);

    interlock.clearAll();
    expect(interlock.inputVersion("binding")).toBe(0);
  });

  it("reports resize quiet time independently from held input quiet time", () => {
    let now = 1_000;
    const interlock = new OperatorInterlock(() => now);
    const release = interlock.beginHold("binding");

    interlock.noteInput("binding");
    now += 100;
    interlock.noteResize("binding");
    expect(interlock.resizeQuietInMs("binding")).toBe(OPERATOR_RESIZE_LATCH_MS);
    expect(interlock.quietInMs("binding")).toBe(OPERATOR_INPUT_LATCH_MS - 100);

    now += 100;
    expect(interlock.resizeQuietInMs("binding")).toBe(OPERATOR_RESIZE_LATCH_MS - 100);
    expect(interlock.quietInMs("binding")).toBe(OPERATOR_INPUT_LATCH_MS - 200);

    now += OPERATOR_RESIZE_LATCH_MS - 100;
    expect(interlock.resizeQuietInMs("binding")).toBe(0);
    expect(interlock.inputActive("binding")).toBe(true);
    expect(interlock.quietInMs("binding")).toBe(50);

    release();
  });
});
