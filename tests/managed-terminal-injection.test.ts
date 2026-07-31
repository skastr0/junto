import { describe, expect, it } from "vitest";
import {
  CLI_CONTRACT,
  WORKER_DOCTRINE,
  buildInjectionText,
  buildSeatContextSection,
  planManagedInjection,
} from "../src/shared/managed-terminal-injection";
import {
  resolveManagedLaunch,
  resolveManagedLaunchPlan,
} from "../src/main/vellum/term/templates/resolve-launch";

const bareAmbient = { PATH: "/usr/bin", HOME: "/home/op" };

const connectedCtx = {
  connected: true as const,
  seatRef: "canvas-a::worker-1",
  connectedTargets: [
    { id: "tasks-main", kind: "tasks", summary: "pull queue" },
    { id: "req-1", kind: "requests" },
  ],
};

describe("managed-terminal injection text", () => {
  it("embeds worker doctrine, CLI contract, and seat slots when connected", () => {
    const text = buildInjectionText(connectedCtx);
    expect(text).not.toBeNull();
    expect(text!).toContain(WORKER_DOCTRINE.slice(0, 40));
    expect(text!).toContain(CLI_CONTRACT.slice(0, 40));
    expect(text!).toContain("vellum onboard");
    expect(text!).toContain("vellum preamble");
    expect(text!).toContain("ScopeError");
    expect(text!).toContain("ClaimConflict");
    expect(text!).toContain("RuntimeDown");
    expect(text!).toContain("Blocked");
    expect(text!).toContain("vellum browser pages --json");
    expect(text!).toContain("managed agent's existing shell");
    expect(text!).toContain("process-bind");
    expect(text!).toContain("canvas-a::worker-1");
    expect(text!).toContain("tasks-main");
    expect(text!).toContain("pull queue");
    expect(text!).toMatch(/claim-is-factory|Claim-is-factory/i);
    expect(text!).toMatch(/Artifacts never block/i);
  });

  it("returns null when unconnected (loop step 2 silence)", () => {
    expect(buildInjectionText({ connected: false })).toBeNull();
    expect(
      buildInjectionText({
        connected: false,
        seatRef: "should-not-appear",
        connectedTargets: [{ id: "x" }],
      }),
    ).toBeNull();
  });

  it("seat context section lists targets or a fallback", () => {
    const filled = buildSeatContextSection({
      seatRef: "seat-9",
      connectedTargets: [{ id: "t1", kind: "tasks" }],
    });
    expect(filled).toContain("seat-9");
    expect(filled).toContain("t1");

    const empty = buildSeatContextSection({});
    expect(empty).toMatch(/unknown at spawn|none listed/i);
  });

  it("plans Tier A systemPrompt for claude/grok and Tier B firstTyped for codex/hermes", () => {
    const claude = planManagedInjection("claude", connectedCtx);
    expect(claude).toMatchObject({ inject: true, tier: "A" });
    expect(claude.systemPrompt).toContain("vellum onboard");
    expect(claude.firstTypedMessage).toBeUndefined();

    const grok = planManagedInjection("grok", connectedCtx);
    expect(grok.tier).toBe("A");
    expect(grok.systemPrompt).toBe(claude.systemPrompt);

    const codex = planManagedInjection("codex", connectedCtx);
    expect(codex).toMatchObject({ inject: true, tier: "B" });
    expect(codex.firstTypedMessage).toContain("vellum onboard");
    expect(codex.systemPrompt).toBeUndefined();

    const hermes = planManagedInjection("hermes", connectedCtx);
    expect(hermes.tier).toBe("B");
    expect(hermes.firstTypedMessage).toBe(codex.firstTypedMessage);
  });

  it("plans inject:false for all harnesses when unconnected", () => {
    for (const harness of ["claude", "codex", "grok", "hermes"] as const) {
      const plan = planManagedInjection(harness, { connected: false });
      expect(plan.inject).toBe(false);
      expect(plan.systemPrompt).toBeUndefined();
      expect(plan.firstTypedMessage).toBeUndefined();
    }
  });
});

describe("resolveManagedLaunchPlan Tier A flags", () => {
  it("claude connected → --append-system-prompt with doctrine", () => {
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
    expect(argv[idx + 1]).toContain("vellum onboard");
    expect(argv[idx + 1]).toContain("canvas-a::worker-1");
  });

  it("grok connected → --rules with doctrine (not --agent unless agentFile)", () => {
    const { launch, injection } = resolveManagedLaunchPlan(
      "grok",
      { injection: connectedCtx, permissionMode: "default" },
      bareAmbient,
    );
    expect(injection.inject).toBe(true);
    const argv = launch.argv ?? [];
    expect(argv).toContain("--rules");
    expect(argv).not.toContain("--agent");
    const idx = argv.indexOf("--rules");
    expect(argv[idx + 1]).toContain("Worker doctrine");
  });

  it("codex/hermes connected → no spawn system flags; firstTypedMessage set", () => {
    for (const harness of ["codex", "hermes"] as const) {
      const plan = resolveManagedLaunchPlan(
        harness,
        { injection: connectedCtx },
        bareAmbient,
      );
      expect(plan.injection.inject).toBe(true);
      expect(plan.injection.tier).toBe("B");
      expect(plan.firstTypedMessage).toContain("vellum onboard");
      const argv = plan.launch.argv ?? [];
      expect(argv).not.toContain("--append-system-prompt");
      expect(argv).not.toContain("--rules");
    }
  });

  it("unconnected → no injection flags and no firstTypedMessage", () => {
    for (const harness of ["claude", "codex", "grok", "hermes"] as const) {
      const plan = resolveManagedLaunchPlan(
        harness,
        {
          injection: { connected: false },
          // Would inject if connection gate were ignored:
          systemPrompt: "SHOULD NOT APPEAR",
          agentFile: harness === "grok" ? "/tmp/evil-agent.md" : undefined,
        },
        bareAmbient,
      );
      expect(plan.injection.inject).toBe(false);
      expect(plan.firstTypedMessage).toBeUndefined();
      const argv = plan.launch.argv ?? [];
      expect(argv).not.toContain("SHOULD NOT APPEAR");
      expect(argv).not.toContain("--append-system-prompt");
      expect(argv).not.toContain("--rules");
      expect(argv).not.toContain("--agent");
      expect(argv).not.toContain("/tmp/evil-agent.md");
    }
  });

  it("resolveManagedLaunch still returns TerminalLaunch only", () => {
    const launch = resolveManagedLaunch(
      "claude",
      { injection: connectedCtx },
      bareAmbient,
    );
    expect(launch.kind).toBe("harness");
    expect(launch.argv ?? []).toContain("--append-system-prompt");
  });

  it("without injection context, explicit systemPrompt still works (manual override)", () => {
    const launch = resolveManagedLaunch(
      "claude",
      { systemPrompt: "manual doctrine" },
      bareAmbient,
    );
    expect(launch.argv ?? []).toContain("--append-system-prompt");
    expect(launch.argv ?? []).toContain("manual doctrine");
  });
});
