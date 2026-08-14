import { describe, expect, it } from "vitest";
import { reviveTermHostEvent } from "../src/main/vellum/term/control-client";

describe("term seat-state hop decode", () => {
  it("revives a Mini observer event for Command Center cards", () => {
    const event = reviveTermHostEvent({
      type: "seat-state",
      bindingId: "bind_remote",
      epoch: "e9",
      event: {
        bindingId: "bind_remote",
        epoch: "e9",
        state: "working",
        reason: "rule:grid_thinking_working",
        confidence: "high",
        at: 1_700_000_000_000,
        harness: "grok",
      },
    });
    expect(event).toEqual({
      type: "seat-state",
      bindingId: "bind_remote",
      epoch: "e9",
      event: {
        bindingId: "bind_remote",
        epoch: "e9",
        state: "working",
        reason: "rule:grid_thinking_working",
        confidence: "high",
        at: 1_700_000_000_000,
        harness: "grok",
      },
    });
  });

  it("drops a malformed seat-state frame", () => {
    expect(
      reviveTermHostEvent({
        type: "seat-state",
        bindingId: "bind_remote",
        epoch: "e9",
        event: { state: "working" },
      }),
    ).toBeUndefined();
  });
});
