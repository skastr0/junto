import { describe, expect, it } from "vitest";
import {
  BASE_CONTRACT,
  WORKER_DOCTRINE,
  VELLUM_INTRO,
  SEAT_DOCTRINE,
  buildInjectionText,
  buildSeatContextSection,
  planManagedInjection,
  compileEdgeSlots,
  targetsBySlot,
  composeEdgeMapChangeNotice,
  planEdgeMapChanges,
} from "../src/shared/managed-terminal-injection";
import { BROWSER_ENABLED } from "../src/shared/features";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  resolveManagedLaunch,
  resolveManagedLaunchPlan,
} from "../src/main/vellum/term/templates/resolve-launch";

const bareAmbient = { PATH: "/usr/bin", HOME: "/home/op" };

const connectedCtx = {
  seatBound: true as const,
  connected: true as const,
  seatRef: "canvas-a::worker-1",
  connectedTargets: [
    { id: "tasks-main", kind: "task", summary: "pull queue" },
    { id: "req-1", kind: "requests" },
    { id: "peer-2", kind: "agent", summary: "Grok seat" },
  ],
};

const seatOnlyCtx = {
  seatBound: true as const,
  connected: false as const,
  seatRef: "canvas-a::worker-1",
  connectedTargets: [],
};

describe("compiled doctrine — base and slots", () => {
  it("canvas seats always get base doctrine (intro, seat doctrine, worker, base contract)", () => {
    const text = buildInjectionText(seatOnlyCtx);
    expect(text).not.toBeNull();
    expect(text!).toContain(VELLUM_INTRO.slice(0, 40));
    expect(text!).toContain(SEAT_DOCTRINE.slice(0, 20));
    expect(text!).toContain(WORKER_DOCTRINE.slice(0, 40));
    expect(text!).toContain(BASE_CONTRACT.slice(0, 40));
    expect(text!).toContain("vellum-command onboard");
    expect(text!).toContain("process-bind");
  });

  it("detached terminals get silence (null body)", () => {
    expect(buildInjectionText({ seatBound: false, connected: false })).toBeNull();
    expect(
      buildInjectionText({
        seatBound: false,
        connected: false,
        seatRef: "should-not-appear",
        connectedTargets: [{ id: "x", kind: "task" }],
      }),
    ).toBeNull();
  });

  it("compiles edge contracts only for connected kinds", () => {
    const text = buildInjectionText(connectedCtx)!;
    // tasks slot
    expect(text).toContain("### Edge contract — tasks");
    expect(text).toContain(`vellum-command tasks list '{"target":"tasks-main"}'`);
    expect(text).toContain("Finish criteria are **hard gates**");
    // escalate slot
    expect(text).toContain("### Edge contract — requests / escalate");
    expect(text).toContain(`vellum-command escalate '{"target":"req-1"`);
    // msg slot
    expect(text).toContain("### Edge contract — messages");
    expect(text).toContain("factory mail");
    // NOT compiled: artifacts / board (no such edges)
    expect(text).not.toContain("### Edge contract — artifacts");
    expect(text).not.toContain("### Edge contract — board");
    expect(text).not.toContain("artifact publish");
    expect(text).not.toContain("board list");
  });

  it("isolated seats (no edges) get no edge contracts and no intro promise", () => {
    const text = buildInjectionText(seatOnlyCtx)!;
    expect(text).not.toContain("### Edge contract —");
    expect(text).not.toContain("### Edge contracts");
    expect(text).not.toContain("compiled from the edges connected at spawn");
    expect(text).not.toContain("vellum-command tasks list");
    expect(text).not.toContain("vellum-command escalate");
    expect(text).not.toContain("vellum-command artifact");
    expect(text).toMatch(/none at spawn/i);
  });

  it("connected seats get the edge-contracts intro before their slots", () => {
    const text = buildInjectionText(connectedCtx)!;
    const intro = text.indexOf("### Edge contracts");
    const firstSlot = text.indexOf("### Edge contract — tasks");
    expect(intro).toBeGreaterThan(-1);
    expect(firstSlot).toBeGreaterThan(intro);
  });

  it("targetsBySlot groups by physics-mirrored kind", () => {
    const grouped = targetsBySlot(connectedCtx.connectedTargets);
    expect(grouped.get("tasks")?.map((t) => t.id)).toEqual(["tasks-main"]);
    expect(grouped.get("escalate")?.map((t) => t.id)).toEqual(["req-1"]);
    expect(grouped.get("msg")?.map((t) => t.id)).toEqual(["peer-2"]);
    expect(grouped.has("artifacts")).toBe(false);
  });

  it("compileEdgeSlots emits one section per present slot kind", () => {
    const slots = compileEdgeSlots(connectedCtx.connectedTargets);
    expect(slots.length).toBe(3);
    expect(slots.join("\n")).toContain("### Edge contract — tasks");
    expect(slots.join("\n")).toContain("### Edge contract — requests / escalate");
    expect(slots.join("\n")).toContain("### Edge contract — messages");
  });

  it("seat context section lists targets or a fallback", () => {
    const filled = buildSeatContextSection({
      seatRef: "seat-9",
      connectedTargets: [{ id: "t1", kind: "tasks" }],
    });
    expect(filled).toContain("seat-9");
    expect(filled).toContain("t1");

    const empty = buildSeatContextSection({});
    expect(empty).toMatch(/unknown at spawn|none at spawn/i);
  });
});

describe("edge-map change injection", () => {
  const doc = (edges: Array<[string, string]>): CanvasDoc => ({
    nodes: [
      { id: "seat-a", type: "text", text: "a", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "agent" } } },
      { id: "n-tasks", type: "text", text: "t", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "task" } } },
      { id: "n-req", type: "text", text: "t", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "requests" } } },
      { id: "n-art", type: "text", text: "t", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "artifacts" } } },
    ],
    edges: edges.map(([fromNode, toNode], i) => ({ id: `e${i}`, fromNode, toNode })),
  });

  it("plans added and removed slot-bearing edges per seat", () => {
    const before = doc([["seat-a", "n-tasks"]]);
    const after = doc([
      ["seat-a", "n-req"],
      ["seat-a", "n-art"],
    ]);
    const changes = planEdgeMapChanges(before, after);
    expect(changes.length).toBe(1);
    expect(changes[0].seatId).toBe("seat-a");
    expect(changes[0].added.map((t) => t.id).sort()).toEqual(["n-art", "n-req"]);
    expect(changes[0].removed.map((t) => t.id)).toEqual(["n-tasks"]);
  });

  it("does not plan when the edge map is unchanged", () => {
    const same = doc([["seat-a", "n-tasks"]]);
    expect(planEdgeMapChanges(same, same)).toEqual([]);
  });

  it("composes a compact map-change notice with inline contracts for additions", () => {
    const text = composeEdgeMapChangeNotice({
      seatId: "seat-a",
      added: [{ id: "n-tasks", kind: "task" }],
      removed: [{ id: "n-req", kind: "requests" }],
    });
    expect(text).toContain("[factory - map]");
    expect(text).toContain("n-tasks");
    expect(text).toContain("### Edge contract — tasks");
    expect(text).toContain("vellum-command tasks list");
    expect(text).toContain("Removed: `n-req`");
    expect(text).not.toContain("### Edge contract — requests");
  });

  it("map-unchanged notice is a one-line orient hint", () => {
    const text = composeEdgeMapChangeNotice({ seatId: "s", added: [], removed: [] });
    expect(text).toContain("edge map unchanged");
    expect(text.split("\n").length).toBe(1);
  });
});

describe("ONE doctrine — tiers are delivery method only", () => {
  it("content is identical across harnesses and delivery slots for the same context", () => {
    for (const ctx of [
      connectedCtx,
      seatOnlyCtx,
      {
        seatBound: true as const,
        connected: true as const,
        seatRef: "s2",
        connectedTargets: [
          { id: "a", kind: "artifacts" },
          { id: "b", kind: "board" },
          { id: "p", kind: "agent" },
        ],
      },
    ]) {
      const text = buildInjectionText(ctx)!;
      const claude = planManagedInjection("claude", ctx);
      const grok = planManagedInjection("grok", ctx);
      const codex = planManagedInjection("codex", ctx);
      expect(claude.systemPrompt).toBe(text);
      expect(grok.systemPrompt).toBe(text);
      expect(codex.firstTypedMessage).toBe(text);
      expect(codex.systemPrompt).toBeUndefined();
      expect(claude.firstTypedMessage).toBeUndefined();
    }
  });

  it("the edge slot builders are the same content as the compiled body", () => {
    const text = buildInjectionText(connectedCtx)!;
    const slotText = compileEdgeSlots(connectedCtx.connectedTargets).join("\n");
    // The compiled body embeds exactly the same slot sections, not variants.
    for (const slot of compileEdgeSlots(connectedCtx.connectedTargets)) {
      expect(text).toContain(slot);
    }
    expect(slotText.length).toBeGreaterThan(0);
  });
});

describe("planManagedInjection tier resolution", () => {
  it("plans Tier A systemPrompt for claude/grok and Tier B firstTyped for codex/hermes", () => {
    const claude = planManagedInjection("claude", connectedCtx);
    expect(claude).toMatchObject({ inject: true, tier: "A" });
    expect(claude.systemPrompt).toContain("vellum-command onboard");
    expect(claude.firstTypedMessage).toBeUndefined();

    const grok = planManagedInjection("grok", connectedCtx);
    expect(grok.tier).toBe("A");
    expect(grok.systemPrompt).toBe(claude.systemPrompt);

    const codex = planManagedInjection("codex", connectedCtx);
    expect(codex).toMatchObject({ inject: true, tier: "B" });
    expect(codex.firstTypedMessage).toContain("vellum-command onboard");
    expect(codex.systemPrompt).toBeUndefined();

    const hermes = planManagedInjection("hermes", connectedCtx);
    expect(hermes.tier).toBe("B");
    expect(hermes.firstTypedMessage).toBe(codex.firstTypedMessage);
  });

  it("canvas seat without edges still injects the base doctrine", () => {
    const plan = planManagedInjection("claude", seatOnlyCtx);
    expect(plan.inject).toBe(true);
    expect(plan.tier).toBe("A");
    expect(plan.systemPrompt).toContain("## Seats");
    expect(plan.systemPrompt).not.toContain("### Edge contract —");
  });

  it("plans inject:false for detached terminals", () => {
    for (const harness of ["claude", "codex", "grok", "hermes"] as const) {
      const plan = planManagedInjection(harness, {
        seatBound: false,
        connected: false,
      });
      expect(plan.inject).toBe(false);
      expect(plan.systemPrompt).toBeUndefined();
      expect(plan.firstTypedMessage).toBeUndefined();
    }
  });
});

describe("resolveManagedLaunchPlan Tier A flags", () => {
  it("claude seat → --append-system-prompt with doctrine", () => {
    const { launch, injection, firstTypedMessage } = resolveManagedLaunchPlan(
      "claude",
      {
        model: "sonnet",
        injection: connectedCtx,
      },
      bareAmbient,
    );
    expect(injection.inject).toBe(true);
    expect(injection.tier).toBe("A");
    expect(firstTypedMessage).toBeUndefined();
    const argv = launch.argv ?? [];
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toContain("vellum-command onboard");
    expect(argv[idx + 1]).toContain("canvas-a::worker-1");
  });

  it("grok seat → --rules with doctrine (not --agent unless agentFile)", () => {
    const { launch, injection } = resolveManagedLaunchPlan(
      "grok",
      { injection: connectedCtx, permissionMode: "default" },
      bareAmbient,
    );
    expect(injection.inject).toBe(true);
    const argv = launch.argv ?? [];
    expect(argv).toContain("--rules");
    expect(argv).not.toContain("--agent");
    expect(argv).not.toContain("--append-system-prompt");
  });

  it("detached terminal → no Tier A flags", () => {
    const { launch, injection } = resolveManagedLaunchPlan(
      "claude",
      { injection: { seatBound: false, connected: false } },
      bareAmbient,
    );
    expect(injection.inject).toBe(false);
    const argv = launch.argv ?? [];
    expect(argv).not.toContain("--append-system-prompt");
  });

  if (BROWSER_ENABLED) {
    it("page edge compiles the browser slot", () => {
      const text = buildInjectionText({
        seatBound: true,
        connected: true,
        seatRef: "s1",
        connectedTargets: [{ id: "page-1", kind: "page" }],
      })!;
      expect(text).toContain("### Edge contract — browser");
      expect(text).toContain("vellum-command browser pages");
    });
  }
});
