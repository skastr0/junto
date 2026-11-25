import { describe, expect, it } from "vitest";
import { newSignalId } from "../src/core/signals/signal-id";

describe("a new signal's id", () => {
  it("sorts in the order the signals were made, even within one millisecond", () => {
    const ids = Array.from({ length: 2000 }, () => newSignalId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
