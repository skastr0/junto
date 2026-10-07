import { describe, expect, it, vi } from "vitest";
import type { TerminalManagedPromptResult } from "../src/shared/ipc";
import { asCanvasName } from "../src/shared/model";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { note as noteNode, seat as seatNode } from "./support/model-nodes";
import {
  planSeatMessage,
  planSeatMessageFor,
  seatMessageOutcome,
  seatMessageReach,
  seatMessageTitle,
  sendSeatMessage,
} from "../src/renderer/lib/seat-message";

const seat = (id: string, name: string) => seatNode(id, {
  label: name,
  bindingId: `bind-${id}` as ReturnType<typeof seatNode>["bindingId"],
});
const note = noteNode("n", "a note");

describe("planSeatMessage", () => {
  it("targets each selected seat once, uses its authored name, and skips other kinds", () => {
    const a = seat("a", "Cursor Agent");
    const plan = planSeatMessage([a, seat("b", "Chat"), a, note]);
    expect(plan.targets.map((target) => target.nodeId)).toEqual(["a", "b"]);
    expect(plan.unreachable).toBe(0);
    expect(plan.names.get("a")).toBe("Cursor Agent");
    expect(seatMessageTitle(plan)).toBe("Message 2 agents");
    expect(seatMessageReach(plan)).toBe("");
  });

  it("titles a single seat by its name and says nothing about reach", () => {
    const plan = planSeatMessage([seat("a", "Cursor Agent")]);
    expect(seatMessageTitle(plan)).toBe("Message Cursor Agent");
    expect(seatMessageReach(plan)).toBe("");
  });
});

describe("seatMessageOutcome", () => {
  const one = planSeatMessage([seat("a", "Cursor Agent")]);
  const three = planSeatMessage([seat("a", "Ada"), seat("b", "Bo"), seat("c", "Cy")]);

  it("says sent, or queued with when the seat gets it", () => {
    expect(seatMessageOutcome(one, { sent: 1, queued: [], failed: [] }, true)).toEqual({
      tone: "sent",
      line: "Sent to Cursor Agent.",
      keepDraft: false,
    });
    const queued = { sent: 0, queued: [{ nodeId: "a", agentKey: "local:a" }], failed: [] };
    expect(seatMessageOutcome(one, queued, true).line).toBe("Queued. Cursor Agent gets it as soon as it is up.");
    expect(seatMessageOutcome(one, queued, false).line).toBe("Queued. Cursor Agent gets it when you press play.");
    expect(seatMessageOutcome(one, queued, true).tone).toBe("queued");
  });

  it("keeps the draft when a seat refused it, and says why", () => {
    const out = seatMessageOutcome(one, { sent: 0, queued: [], failed: [{ nodeId: "a", agentKey: "local:a", error: "seat is gone" }] }, true);
    expect(out).toEqual({ tone: "failed", line: "Not sent to Cursor Agent: seat is gone", keepDraft: true });
  });

  it("sums a selection, naming the seats that did not get it now", () => {
    const out = seatMessageOutcome(
      three,
      {
        sent: 1,
        queued: [{ nodeId: "b", agentKey: "local:b" }],
        failed: [{ nodeId: "c", agentKey: "local:c", error: "x" }],
      },
      true,
    );
    expect(out.tone).toBe("failed");
    expect(out.keepDraft).toBe(true);
    expect(out.line).toBe("Sent to 1 agent. Queued for Bo, who gets it as soon as it is up. Not sent to Cy.");
    const twoQueued = seatMessageOutcome(
      three,
      { sent: 1, queued: [{ nodeId: "b", agentKey: "local:b" }, { nodeId: "c", agentKey: "local:c" }], failed: [] },
      false,
    );
    expect(twoQueued.line).toBe("Sent to 1 agent. Queued for Bo, Cy, who get it when you press play.");
    expect(twoQueued.tone).toBe("queued");
  });
});

describe("sendSeatMessage", () => {
  it("sends the trimmed text to every target through the prompt path, asking to wake down seats", async () => {
    const writePrompt = vi.fn(
      async (input: { readonly bindingId: string }): Promise<TerminalManagedPromptResult> =>
        input.bindingId === "bind-b" ? { ok: true, disposition: "queued" } : { ok: true, disposition: "submitted" },
    );
    const plan = planSeatMessage([seat("a", "Ada"), seat("b", "Bo")]);
    const out = await sendSeatMessage(plan, "  ship it  ", { writePrompt, canvasName: "main" });
    expect(writePrompt).toHaveBeenCalledTimes(2);
    expect(writePrompt.mock.calls.map(([input]) => input)).toEqual([
      { bindingId: "bind-a", text: "ship it", canvasName: "main", nodeId: "a", wake: true },
      { bindingId: "bind-b", text: "ship it", canvasName: "main", nodeId: "b", wake: true },
    ]);
    expect(out.tone).toBe("queued");
    expect(out.line).toBe("Sent to 1 agent. Queued for Bo, who gets it as soon as it is up.");
  });
});

describe("planSeatMessageFor", () => {
  it("reads the seats by id from the canvas the store holds, each once, and skips what is not on it", () => {
    const previous = state$.canvasName.peek();
    const release = modelStore.adopt({
      canvas: asCanvasName("plan"),
      seq: 0,
      nodes: [seatNode("a", { label: "Ada" }), seatNode("b", { label: "Bo" }), noteNode("n")],
      wires: [],
    });
    state$.canvasName.set("plan");
    try {
      const plan = planSeatMessageFor(["b", "a", "b", "n", "gone"]);
      expect(plan.targets.map((target) => target.nodeId)).toEqual(["b", "a"]);
      expect(plan.targets[0]).toEqual({ nodeId: "b", bindingId: "binding-b", agentKey: "local:b" });
      expect(plan.unreachable).toBe(0);
      expect([...plan.names]).toEqual([["b", "Bo"], ["a", "Ada"]]);
    } finally {
      state$.canvasName.set(previous);
      release();
    }
  });
});
