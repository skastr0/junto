import { describe, expect, it } from "vitest";
import {
  BASE_CONTRACT,
  WORKER_DOCTRINE,
  JUNTO_INTRO,
  SEAT_DOCTRINE,
  buildInjectionText,
  buildSeatContextSection,
  planManagedInjection,
  compileEdgeSlots,
  targetsBySlot,
} from "../src/shared/managed-terminal-injection";
import { BROWSER_ENABLED } from "../src/shared/features";
import { compileVerb } from "../src/shared/physics/verbs";
import {
  resolveManagedLaunch,
  resolveManagedLaunchPlan,
} from "../src/main/junto/term/templates/resolve-launch";

const bareAmbient = { PATH: "/usr/bin", HOME: "/home/op" };
const taskPorts = compileVerb("contributes", "agent", "task")!.ports;
const requestPorts = compileVerb("escalates", "agent", "requests")!.ports;
const peerPorts = compileVerb("messages", "agent", "agent")!.ports;

const connectedCtx = {
  seatBound: true as const,
  connected: true as const,
  seatRef: "canvas-a::worker-1",
  connectedTargets: [
    { id: "tasks-main", kind: "task", summary: "pull queue", ports: taskPorts },
    { id: "req-1", kind: "requests", ports: requestPorts },
    { id: "peer-2", kind: "agent", summary: "Grok seat", ports: peerPorts },
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
    expect(text!).toContain(JUNTO_INTRO.slice(0, 40));
    expect(text!).toContain(SEAT_DOCTRINE.slice(0, 20));
    expect(text!).toContain(WORKER_DOCTRINE.slice(0, 40));
    expect(text!).toContain(BASE_CONTRACT.slice(0, 40));
    expect(text!).toContain("junto onboard");
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
    expect(text).toContain(`junto tasks list '{"target":"tasks-main"}'`);
    expect(text).toContain("Finish criteria are **hard gates**");
    // escalate slot
    expect(text).toContain("### Edge contract — requests / escalate");
    expect(text).toContain(`junto escalate '{"target":"req-1"`);
    // msg slot
    expect(text).toContain("### Edge contract — messages");
    expect(text).toContain("pull-only");
    expect(text).toContain("not a live-qualified delivery channel");
    expect(text).toContain("mail from <seat>");
    expect(text).toContain("[factory mail from …]");
    expect(text).toContain("msg.prompt");
    expect(text).toContain("seat.wait");
    expect(text).toContain("terminal.read");
    expect(text).toContain("`notice`");
    expect(text).toContain("`prompt`");
    expect(text).toContain("`receipt`");
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
    expect(text).not.toContain("junto tasks list");
    expect(text).not.toContain("junto escalate");
    expect(text).not.toContain("junto artifact");
    expect(text).toMatch(/none at spawn/i);
  });

  it("connected seats get the edge-contracts intro before their slots", () => {
    const text = buildInjectionText(connectedCtx)!;
    const intro = text.indexOf("### Edge contracts");
    const firstSlot = text.indexOf("### Edge contract — tasks");
    expect(intro).toBeGreaterThan(-1);
    expect(firstSlot).toBeGreaterThan(intro);
  });

  it("targetsBySlot groups by held command-family ports", () => {
    const grouped = targetsBySlot(connectedCtx.connectedTargets);
    expect(grouped.get("tasks")?.map((t) => t.id)).toEqual(["tasks-main"]);
    expect(grouped.get("escalate")?.map((t) => t.id)).toEqual(["req-1"]);
    expect(grouped.get("msg")?.map((t) => t.id)).toEqual(["tasks-main", "req-1", "peer-2"]);
    expect(grouped.has("artifacts")).toBe(false);
    expect(grouped.has("pad")).toBe(false);
  });

  it("compiles the pad edge contract when a pad is connected", () => {
    const slots = compileEdgeSlots([{ id: "pad-1", kind: "pad", ports: ["pad.read", "pad.patch"] }]);
    expect(slots.join("\n")).toContain("### Edge contract — pad");
    expect(slots.join("\n")).toContain(`junto pad read '{"target":"pad-1"}'`);
    expect(slots.join("\n")).toContain("junto pad look-here");
    expect(slots.join("\n")).toContain("junto pad tagged");
    expect(slots.join("\n")).toContain("ink or image");
    expect(slots.join("\n")).toContain("inbound actor");
  });

  it("compiles the sheet edge contract, and it names no write command", () => {
    const slots = compileEdgeSlots([{ id: "sheet-1", kind: "sheet", ports: ["sheet.read"] }]).join("\n");
    expect(slots).toContain("### Edge contract — sheet");
    expect(slots).toContain(`junto sheet read '{"target":"sheet-1"}'`);
    expect(slots).not.toContain("sheet patch");
    expect(slots).not.toContain("sheet write");
  });

  it("compileEdgeSlots separates targets with different held ports", () => {
    const slots = compileEdgeSlots(connectedCtx.connectedTargets);
    expect(slots.length).toBe(4);
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
          { id: "a", kind: "artifacts", ports: compileVerb("publishes", "agent", "artifacts")!.ports },
          { id: "b", kind: "board", ports: compileVerb("participates", "agent", "board")!.ports },
          { id: "p", kind: "agent", ports: peerPorts },
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
    expect(claude.systemPrompt).toContain("junto onboard");
    expect(claude.firstTypedMessage).toBeUndefined();

    const grok = planManagedInjection("grok", connectedCtx);
    expect(grok.tier).toBe("A");
    expect(grok.systemPrompt).toBe(claude.systemPrompt);

    const codex = planManagedInjection("codex", connectedCtx);
    expect(codex).toMatchObject({ inject: true, tier: "B" });
    expect(codex.firstTypedMessage).toContain("junto onboard");
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
    expect(argv[idx + 1]).toContain("junto onboard");
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

  it("amp and fx firstTyped a one-line onboard pointer, not the full doctrine", () => {
    for (const harness of ["amp", "fx"] as const) {
      const { firstTypedMessage } = resolveManagedLaunchPlan(
        harness,
        { injection: connectedCtx },
        bareAmbient,
      );
      expect(firstTypedMessage).toBeTruthy();
      expect(firstTypedMessage).not.toContain("\n");
      expect(firstTypedMessage).toContain("junto onboard");
      expect(firstTypedMessage).not.toContain("# Junto");
    }
  });

  if (BROWSER_ENABLED) {
    it("page edge compiles the browser slot", () => {
      const text = buildInjectionText({
        seatBound: true,
        connected: true,
        seatRef: "s1",
        connectedTargets: [{ id: "page-1", kind: "page", ports: ["browser.automate"] }],
      })!;
      expect(text).toContain("### Edge contract — browser");
      expect(text).toContain("junto browser pages");
    });
  }
  it("appends the operator-authored region briefing as the final supplemental section", () => {
    const body = buildInjectionText({
      seatBound: true,
      connected: false,
      seatRef: "n3",
      regionInstruction: "Squad A: keep changes small; ask before touching licensing.",
    });
    expect(body).toContain("## Region briefing (operator-authored)");
    expect(body).toContain("Squad A: keep changes small; ask before touching licensing.");
    // Last section: the base doctrine stays immutable; the region is the tail layer.
    expect(body?.trimEnd().endsWith("ask before touching licensing.")).toBe(true);
  });

  it("omits the region briefing when the seat has none", () => {
    const body = buildInjectionText({ seatBound: true, connected: false, seatRef: "n3" });
    expect(body).not.toContain("Region briefing");
  });

  it("compiles worked examples only for the slots the seat holds", () => {
    const tasksOnly = buildInjectionText({
      seatBound: true,
      connected: true,
      seatRef: "n3",
      connectedTargets: [{ id: "n7", kind: "tasks", summary: "Sprint board", ports: taskPorts }],
    });
    expect(tasksOnly).toContain("## Worked examples");
    expect(tasksOnly).toContain('tasks claim {"target":"n7","task":"t1"}');
    expect(tasksOnly).toContain("completionEvidence");
    expect(tasksOnly).not.toContain('"target":"req1"');

    const requestsOnly = buildInjectionText({
      seatBound: true,
      connected: true,
      seatRef: "n3",
      connectedTargets: [{ id: "n8", kind: "requests", summary: "Requests", ports: requestPorts }],
    });
    expect(requestsOnly).toContain('junto escalate {"target":"req1","brief":"need API key for staging","reason":"cannot continue without operator secret"}');
    // The worker-loop doctrine names `tasks claim` in prose for every seat;
    // what a requests-only seat must never get is the tasks CLI surface.
    expect(requestsOnly).not.toContain("junto tasks claim");
    expect(requestsOnly).not.toContain('tasks claim {"target"');
  });

  it("never promises worked examples to isolated seats", () => {
    const body = buildInjectionText({ seatBound: true, connected: false, seatRef: "n3" });
    expect(body).not.toContain("Worked examples");
  });
});
