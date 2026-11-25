import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { openSignalCount, signalsCloseLine } from "../src/window/lib/canvas-delete";

const signal = (signalId: string, state: AgentSignal["state"], canvasName = "c", source?: string) =>
  ({ signalId, state, canvasName, nodeId: `n-${signalId}`, kind: "escalate", ...(source === undefined ? {} : { source }) }) as unknown as AgentSignal;

describe("what a canvas delete closes", () => {
  it("counts every open signal on the canvas, whatever its kind, and no closed one", () => {
    const signals = [
      signal("a", "open"),
      signal("b", "open", "c", "automation"),
      signal("c", "answered"),
      signal("d", "dismissed"),
      signal("e", "withdrawn"),
      signal("f", "open", "other"),
    ];
    expect(openSignalCount(signals, "c")).toBe(2);
    expect(openSignalCount([], "c")).toBe(0);
  });
  it("says one line, only when something is open", () => {
    expect(signalsCloseLine(0)).toBeUndefined();
    expect(signalsCloseLine(1)).toBe("1 open signal closes with it.");
    expect(signalsCloseLine(3)).toBe("3 open signals close with it.");
  });
});
