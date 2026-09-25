import { describe, expect, it, vi } from "vitest";
import type { AgentSeatState } from "../src/shared/agent-seat-state";
import {
  AGENT_BROADCAST_KINDS,
  AGENT_BROADCAST_PROMPTS,
} from "../src/shared/agent-broadcast-prompts";
import type { CanvasNode } from "../src/shared/canvas";
import type { TerminalManagedPromptResult } from "../src/shared/ipc";
import {
  broadcastMenuHint,
  broadcastNeedsNotice,
  broadcastToAgents,
  formatBroadcastOutcome,
  planAgentBroadcast,
} from "../src/renderer/lib/agent-broadcast";

const base = { x: 0, y: 0, width: 200, height: 80, type: "text", text: "" } as const;

const seat = (id: string, bindingId?: string): CanvasNode => ({
  ...base,
  id,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    ...(bindingId
      ? {
          terminal: {
            bindingId,
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        }
      : {}),
  },
});

const note = (id: string): CanvasNode => ({ ...base, id });

const states =
  (map: Record<string, AgentSeatState>) =>
  (bindingId: string): AgentSeatState | undefined =>
    map[bindingId];

describe("planAgentBroadcast", () => {
  it("targets only agent seats with a live terminal and counts the rest as skipped", () => {
    const plan = planAgentBroadcast(
      [
        seat("idle", "b-idle"),
        seat("working", "b-working"),
        seat("attention", "b-attention"),
        seat("gone", "b-gone"),
        seat("unknown", "b-unknown"),
        seat("unseen", "b-unseen"),
        seat("unbound"),
        note("n"),
      ],
      states({
        "b-idle": "idle",
        "b-working": "working",
        "b-attention": "attention",
        "b-gone": "gone",
        "b-unknown": "unknown",
      }),
    );
    expect(plan.agents).toBe(7);
    expect(plan.live.map((target) => target.nodeId)).toEqual(["idle", "working", "attention"]);
    expect(plan.skipped).toBe(4);
  });

  it("counts a node selected twice once", () => {
    const a = seat("a", "b-a");
    const plan = planAgentBroadcast([a, a], states({ "b-a": "idle" }));
    expect(plan).toMatchObject({ agents: 1, skipped: 0 });
    expect(plan.live).toHaveLength(1);
  });

  it("has no agents when the selection has none", () => {
    expect(planAgentBroadcast([note("x")], states({}))).toEqual({ agents: 0, live: [], skipped: 0 });
  });
});

describe("broadcastMenuHint", () => {
  it("shows the plain count when every agent is live, else live of total", () => {
    const all = planAgentBroadcast([seat("a", "b-a"), seat("b", "b-b")], states({ "b-a": "idle", "b-b": "working" }));
    expect(broadcastMenuHint(all)).toBe("2 agents");
    const some = planAgentBroadcast([seat("a", "b-a"), seat("b", "b-b")], states({ "b-a": "idle" }));
    expect(broadcastMenuHint(some)).toBe("1 of 2 agents live");
  });
});

describe("broadcastToAgents", () => {
  it("types the pre-configured prompt into live seats only", async () => {
    const writePrompt = vi.fn(async (): Promise<TerminalManagedPromptResult> => ({
      ok: true,
      disposition: "submitted",
    }));
    const plan = planAgentBroadcast(
      [seat("a", "b-a"), seat("b", "b-b"), seat("c")],
      states({ "b-a": "working", "b-b": "gone" }),
    );
    const outcome = await broadcastToAgents("stop", plan, { writePrompt, canvasName: "main" });
    expect(writePrompt).toHaveBeenCalledTimes(1);
    expect(writePrompt).toHaveBeenCalledWith({
      bindingId: "b-a",
      text: AGENT_BROADCAST_PROMPTS.stop.text,
      canvasName: "main",
      nodeId: "a",
    });
    expect(formatBroadcastOutcome(outcome)).toBe("stop sent to 1 agent, 2 skipped with no live terminal");
    expect(broadcastNeedsNotice(outcome)).toBe(true);
  });

  it("reports queued and failed seats and stays quiet on full delivery", async () => {
    const byBinding: Record<string, TerminalManagedPromptResult> = {
      "b-a": { ok: true, disposition: "submitted" },
      "b-b": { ok: true, disposition: "queued" },
      "b-c": { ok: false, disposition: "failed", error: "boom" },
    };
    const writePrompt = vi.fn(async (input: { bindingId: string }) => byBinding[input.bindingId]!);
    const all = { "b-a": "idle", "b-b": "idle", "b-c": "idle" } as const;
    const plan = planAgentBroadcast([seat("a", "b-a"), seat("b", "b-b"), seat("c", "b-c")], states(all));
    const outcome = await broadcastToAgents("check", plan, { writePrompt, canvasName: "main" });
    expect(formatBroadcastOutcome(outcome)).toBe(
      "check sent to 1 agent, 1 queued until the seat is up, 1 failed (local:c)",
    );

    const clean = await broadcastToAgents(
      "check",
      planAgentBroadcast([seat("a", "b-a")], states(all)),
      { writePrompt, canvasName: "main" },
    );
    expect(broadcastNeedsNotice(clean)).toBe(false);
  });
});

describe("AGENT_BROADCAST_PROMPTS", () => {
  it("keeps every prompt short and free of middle dots", () => {
    for (const kind of AGENT_BROADCAST_KINDS) {
      const prompt = AGENT_BROADCAST_PROMPTS[kind];
      expect(prompt.kind).toBe(kind);
      expect(prompt.text.length).toBeLessThan(400);
      expect(`${prompt.label}${prompt.ariaLabel}${prompt.text}`).not.toContain("·");
    }
  });

  it("check names the preamble tool", () => {
    expect(AGENT_BROADCAST_PROMPTS.check.text).toContain("junto preamble '{\"text\":");
  });
});
