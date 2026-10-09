import { afterEach, describe, expect, it } from "vitest";
import {
  resetSeatStartTurnForTests,
  runOnSeatStartTurn,
} from "../src/main/junto/term/seat-start-turn";

afterEach(() => {
  resetSeatStartTurnForTests();
});

describe("seat start turn", () => {
  it("runs the next start only after the previous start finishes", async () => {
    const order: string[] = [];
    const first = runOnSeatStartTurn(async () => {
      order.push("first");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      order.push("first-done");
    });
    const second = runOnSeatStartTurn(async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "first-done", "second"]);
  });
});
