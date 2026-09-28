import { describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import type { TerminalManagedPromptResult } from "../src/shared/ipc";
import {
  planSeatMessage,
  seatMessageOutcome,
  seatMessageReach,
  seatMessageTitle,
  sendSeatMessage,
} from "../src/renderer/lib/seat-message";

const base = { x: 0, y: 0, width: 200, height: 80 } as const;

const seat = (id: string, name: string): CanvasNode => ({
  ...base,
  id,
  type: "text",
  text: name,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `bind-${id}`, harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
  },
});

const unbound = (id: string, name: string): CanvasNode => ({
  ...base,
  id,
  type: "text",
  text: name,
  ether: { entity: { kind: "agent", name: `local:${id}` } },
});

const note: CanvasNode = { ...base, id: "n", type: "text", text: "a note" };

describe("planSeatMessage", () => {
  it("targets agents with a terminal, names them as the canvas does, and counts the rest", () => {
    const plan = planSeatMessage([seat("a", "Cursor Agent\nsecond line"), unbound("b", "Chat"), note]);
    expect(plan.targets.map((target) => target.nodeId)).toEqual(["a"]);
    expect(plan.unreachable).toBe(1);
    expect(plan.names.get("a")).toBe("Cursor Agent");
    expect(seatMessageTitle(plan)).toBe("Message 1 agent");
    expect(seatMessageReach(plan)).toBe("1 of 2 agents has no terminal and will not get it.");
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
