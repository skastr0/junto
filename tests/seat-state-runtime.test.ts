import { afterEach, describe, expect, it } from "vitest";
import { SeatStateRuntime } from "../src/main/vellum/term/agent-state/runtime";
import type { ObserverGridSnapshot } from "../src/main/vellum/term/observer/types";
import {
  armFirstTypedMessage,
  clearFirstTypedMessage,
  resetFirstTypedForTest,
  takeFirstTypedMessage,
} from "../src/main/vellum/term/first-typed";

afterEach(() => {
  resetFirstTypedForTest();
});

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

  it("muse fallback idle stays non-typeable without firstTyped doctrine", () => {
    const rt = new SeatStateRuntime({ now: () => 3_000 });
    rt.bindHarness("muse1", "muse", "e1");
    rt.observe(
      snap("muse1", {
        lines: ["Muse Code 0.1.0"],
        signals: {
          title: "",
          osc9: "",
          modes: {
            bracketedPaste: true,
            synchronizedOutput: false,
            altScreen: false,
            mouseModes: [],
          },
        },
      }),
    );
    expect(rt.getState("muse1")).toBe("idle");
    expect(rt.machine.getSlot("muse1")?.confidence).toBe("low");
    expect(rt.isSeatIdle("muse1")).toBe(false);
    rt.stop();
  });

  it("muse is typeable for firstTyped only when handshake paste is on", () => {
    const rt = new SeatStateRuntime({ now: () => 4_000 });
    rt.bindHarness("muse1", "muse", "e1");
    armFirstTypedMessage("muse1", "## Worker doctrine\nonboard …");
    rt.observe(
      snap("muse1", {
        lines: ["Muse Code 0.1.0"],
        signals: {
          title: "",
          osc9: "",
          modes: {
            bracketedPaste: true,
            synchronizedOutput: false,
            altScreen: false,
            mouseModes: [],
          },
        },
      }),
    );
    expect(rt.isSeatIdle("muse1")).toBe(true);
    // After doctrine is taken, gate closes again (no permanent inject).
    takeFirstTypedMessage("muse1");
    expect(rt.isSeatIdle("muse1")).toBe(false);
    rt.stop();
  });

  it("muse firstTyped does not open paste before bracketed-paste handshake", () => {
    const rt = new SeatStateRuntime({ now: () => 5_000 });
    rt.bindHarness("muse1", "muse", "e1");
    armFirstTypedMessage("muse1", "doctrine");
    rt.observe(
      snap("muse1", {
        lines: ["booting"],
        signals: {
          title: "",
          osc9: "",
          modes: {
            bracketedPaste: false,
            synchronizedOutput: false,
            altScreen: false,
            mouseModes: [],
          },
        },
      }),
    );
    expect(rt.isSeatIdle("muse1")).toBe(false);
    clearFirstTypedMessage("muse1");
    rt.stop();
  });
});

describe("SeatStateRuntime composer verdict", () => {
  const HR = "─".repeat(40);

  it("reads the live composer verdict from the fed screen", () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    rt.bindHarness("b1", "claude", "e1");
    rt.observe(snap("b1", { lines: [HR, "❯ ", HR, "footer"] }));
    expect(rt.composerVerdict("b1")).toBe("empty");
    rt.observe(snap("b1", { lines: [HR, "❯ half-typed draft", HR, "footer"] }));
    expect(rt.composerVerdict("b1")).toBe("draft");
    rt.stop();
  });

  it("unbound binding yields null (refuse typing)", () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    expect(rt.composerVerdict("nobody")).toBe(null);
    rt.stop();
  });

  it("notifies subscribers on verdict CHANGE only — draft→empty is the drain boundary", () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    rt.bindHarness("b1", "claude", "e1");
    const seen: Array<[string, string | null]> = [];
    rt.subscribeComposerVerdict((bindingId, verdict) => {
      seen.push([bindingId, verdict]);
    });
    rt.observe(snap("b1", { lines: [HR, "❯ draft", HR, "footer"] }));
    rt.observe(snap("b1", { lines: [HR, "❯ draft", HR, "footer"] }));
    rt.observe(snap("b1", { lines: [HR, "❯ ", HR, "footer"] }));
    rt.observe(snap("b1", { lines: [HR, "❯ ", HR, "footer"] }));
    expect(seen).toEqual([
      ["b1", "draft"],
      ["b1", "empty"],
    ]);
    rt.stop();
  });

  it("computes the verdict even under structured hook authority", () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    rt.bindHarness("b1", "claude", "e1");
    rt.observeStructuredHook({
      bindingId: "b1",
      epoch: "e1",
      state: "idle",
      reason: "reporter",
    });
    const seen: string[] = [];
    rt.subscribeComposerVerdict((_, verdict) => {
      seen.push(String(verdict));
    });
    rt.observe(snap("b1", { lines: [HR, "❯ typed under reporter", HR, "f"] }));
    expect(seen).toEqual(["draft"]);
    expect(rt.composerVerdict("b1")).toBe("draft");
    rt.stop();
  });
});
