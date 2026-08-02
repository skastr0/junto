import { describe, expect, it } from "vitest";
import { SeatStateRuntime } from "../src/main/vellum/term/agent-state/runtime";
import type { ObserverGridSnapshot } from "../src/main/vellum/term/observer/types";

const snap = (
  bindingId: string,
  partial: Partial<ObserverGridSnapshot> & {
    title?: string;
    lines?: string[];
  } = {},
): ObserverGridSnapshot => {
  const lines = partial.lines ?? ["❯ ready"];
  return {
    bindingId,
    epoch: partial.epoch ?? "e1",
    cols: 80,
    rows: 24,
    lines,
    text: lines.join("\n"),
    seq: partial.seq ?? 1n,
    signals: {
      title: partial.title ?? partial.signals?.title ?? "",
      osc9: partial.signals?.osc9 ?? "",
      modes: partial.signals?.modes ?? {
        bracketedPaste: true,
        synchronizedOutput: false,
        altScreen: false,
        mouseModes: [],
      },
    },
  };
};

describe("SeatStateRuntime idle gate", () => {
  it("fail-closed: unbound binding is never idle", () => {
    const rt = new SeatStateRuntime();
    expect(rt.isSeatIdle("missing")).toBe(false);
    rt.stop();
  });

  it("becomes idle after bound harness sees idle chrome", () => {
    const rt = new SeatStateRuntime({ now: () => 1_000 });
    rt.bindHarness("b1", "claude", "e1");
    // Feed through machine directly (runtime.start uses global observer plane).
    const event = rt.machine.feed(
      snap("b1", {
        lines: [
          "────────────────",
          "❯ do work",
          "────────────────",
        ],
        title: "",
      }),
      { harness: "claude" },
    );
    // High-confidence visible idle publishes immediately.
    expect(event?.state === "idle" || rt.getState("b1") === "idle").toBe(true);
    expect(rt.isSeatIdle("b1")).toBe(true);
    rt.stop();
  });

  it("refuses paste auth on low-confidence fallback idle", () => {
    const rt = new SeatStateRuntime({ now: () => 1_500 });
    rt.bindHarness("b1", "claude", "e1");
    rt.machine.feed(snap("b1", { title: "⣿ work", lines: ["…"] }), {
      harness: "claude",
    });
    // Debounce working→fallback idle (3 confirms).
    for (let i = 0; i < 3; i++) {
      rt.machine.feed(snap("b1", { title: "", lines: ["log"] }), {
        harness: "claude",
      });
    }
    expect(rt.getState("b1")).toBe("idle");
    expect(rt.machine.getSlot("b1")?.confidence).toBe("low");
    expect(rt.isSeatIdle("b1")).toBe(false);
    rt.stop();
  });

  it("is not idle while attention", () => {
    const rt = new SeatStateRuntime({ now: () => 2_000 });
    rt.bindHarness("b1", "codex", "e1");
    rt.machine.feed(
      snap("b1", {
        title: "Action Required",
        lines: ["please approve"],
      }),
      { harness: "codex" },
    );
    expect(rt.getState("b1")).toBe("attention");
    expect(rt.isSeatIdle("b1")).toBe(false);
    rt.stop();
  });

  it("emits gone only for the current terminal generation", () => {
    const events: Array<{ readonly epoch: string; readonly state: string }> = [];
    const rt = new SeatStateRuntime({
      now: () => 2_000,
      onEvent: (event) => events.push(event),
    });
    rt.bindHarness("b1", "grok", "e1");
    rt.bindHarness("b1", "grok", "e2");

    rt.unbind("b1", "e1", "late_old_exit");
    expect(rt.machine.getSlot("b1")?.epoch).toBe("e2");

    rt.unbind("b1", "e2", "generation_exited");
    expect(events.at(-1)).toMatchObject({
      epoch: "e2",
      state: "gone",
    });
    expect(rt.getState("b1")).toBeUndefined();
    rt.stop();
  });
});
