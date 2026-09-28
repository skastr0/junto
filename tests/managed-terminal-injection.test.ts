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
  composeEdgeMapChangeNotice,
  planEdgeMapChanges,
} from "../src/shared/managed-terminal-injection";
import { BROWSER_ENABLED } from "../src/shared/features";
import type { CanvasDoc } from "../src/shared/canvas";
import { compileVerb } from "../src/shared/physics/verbs";
import {
  resolveManagedLaunch,
  resolveManagedLaunchPlan,
} from "../src/main/junto/term/templates/resolve-launch";

const bareAmbient = { PATH: "/usr/bin", HOME: "/home/op" };
const peerPorts = compileVerb("messages", "agent", "agent")!.ports;

const connectedCtx = {
  seatBound: true as const,
  connected: true as const,
  seatRef: "canvas-a::worker-1",
  connectedTargets: [
    { id: "peer-2", kind: "agent", summary: "Grok seat", ports: peerPorts },
    { id: "peer-3", kind: "agent", summary: "Codex seat", ports: peerPorts },
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

  it("tells every seat that offboard exists, when to use it, and that past sessions are history", () => {
    const text = buildInjectionText(seatOnlyCtx)!;
    expect(text).toContain("junto offboard");
    expect(text).toContain("what happened, what is relevant, and why it matters");
    expect(text).toContain("when Junto tells you your context is heavy");
    // Short and firm: past sessions are context, never work to pick back up.
    expect(text).toContain(
      "These are PAST sessions of this seat: context for continuity, not ongoing tasks. Do not resume their work unless your current instructions or mail ask you to.",
    );
    expect(text).toContain("open a listed path yourself");
  });

  it("detached terminals get silence (null body)", () => {
    expect(buildInjectionText({ seatBound: false, connected: false })).toBeNull();
    expect(
      buildInjectionText({
        seatBound: false,
        connected: false,
        seatRef: "should-not-appear",
        connectedTargets: [{ id: "x", kind: "agent" }],
      }),
    ).toBeNull();
  });

  it("compiles edge contracts only for connected kinds", () => {
    const text = buildInjectionText(connectedCtx)!;
    // Raising a hand is base doctrine, never an edge slot.
    expect(text).not.toContain("### Edge contract — requests / escalate");
    expect(text).not.toContain(`junto escalate '{"target"`);
    // msg slot
    expect(text).toContain("### Edge contract — messages");
    expect(text).toContain("Mail is never refused and never needs a retry");
    expect(text).toContain("mail from <seat>");
    expect(text).toContain("msg.prompt");
    expect(text).toContain("seat.wait");
    expect(text).toContain("terminal.read");
    expect(text).toContain("`notice`");
    expect(text).toContain("`prompt`");
    expect(text).toContain("`receipt`");
    // NOT compiled: no other kind is wired
    expect(text).not.toContain("### Edge contract — tasks");
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
    expect(text).not.toContain("junto artifact");
    // Every seat can raise its hand, edges or not.
    expect(text).toContain("### Raising your hand");
    expect(text).toContain('junto blocked "..."');
    expect(text).toMatch(/none at spawn/i);
  });

  it("connected seats get the edge-contracts intro before their slots", () => {
    const text = buildInjectionText(connectedCtx)!;
    const intro = text.indexOf("### Edge contracts");
    const firstSlot = text.indexOf("### Edge contract — messages");
    expect(intro).toBeGreaterThan(-1);
    expect(firstSlot).toBeGreaterThan(intro);
  });

  it("targetsBySlot groups by held command-family ports", () => {
    const grouped = targetsBySlot(connectedCtx.connectedTargets);
    expect(grouped.get("msg")?.map((t) => t.id)).toEqual(["peer-2", "peer-3"]);
    expect(grouped.has("tasks")).toBe(false);
    expect(grouped.has("artifacts")).toBe(false);
    expect(grouped.has("pad")).toBe(false);
  });

  it("compileEdgeSlots gathers peers holding the same ports into one slot", () => {
    const slots = compileEdgeSlots(connectedCtx.connectedTargets);
    expect(slots.length).toBe(1);
    expect(slots.join("\n")).not.toContain("requests / escalate");
    expect(slots.join("\n")).toContain("### Edge contract — messages");
  });

  it("seat context section lists targets or a fallback", () => {
    const filled = buildSeatContextSection({
      seatRef: "seat-9",
      connectedTargets: [{ id: "t1", kind: "agent" }],
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
      { id: "n-peer", type: "text", text: "p", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "agent" } } },
      { id: "n-new", type: "text", text: "q", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "agent" } } },
      { id: "n-note", type: "text", text: "n", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "note" } } },
    ],
    edges: edges.map(([fromNode, toNode], i) => ({ id: `e${i}`, fromNode, toNode })),
  });

  it("plans added and removed slot-bearing edges per seat", () => {
    const before = doc([["seat-a", "n-peer"]]);
    const after = doc([
      ["seat-a", "n-new"],
      ["seat-a", "n-note"],
    ]);
    const changes = planEdgeMapChanges(before, after);
    const seatA = changes.find((change) => change.seatId === "seat-a");
    // A note bears no slot: no verb joins an agent to it.
    expect(seatA?.added.map((t) => t.id)).toEqual(["n-new"]);
    expect(seatA?.removed.map((t) => t.id)).toEqual(["n-peer"]);
    // Both peers are seats too, and each hears its own side of the change.
    expect(changes.map((change) => change.seatId).sort()).toEqual(["n-new", "n-peer", "seat-a"]);
  });

  it("does not plan when the edge map is unchanged", () => {
    const same = doc([["seat-a", "n-peer"]]);
    expect(planEdgeMapChanges(same, same)).toEqual([]);
  });

  it("names what the seat can now reach and no longer reach, in one line", () => {
    const text = composeEdgeMapChangeNotice({
      seatId: "seat-a",
      added: [{ id: "alpha", kind: "agent" }, { id: "bravo", kind: "agent" }],
      removed: [{ id: "charlie", kind: "agent" }],
    });
    expect(text).toBe(
      "Your connections changed. You can now reach `alpha` (agent), `bravo` (agent). " +
        "You can no longer reach `charlie` (agent). Run `junto capabilities` for details.",
    );
  });

  it("says plainly when nothing changed", () => {
    expect(composeEdgeMapChangeNotice({ seatId: "s", added: [], removed: [] })).toBe(
      "Your connections did not change. Run `junto capabilities` to see them.",
    );
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

  it("teaches every connected seat to raise its hand, and no task surface", () => {
    const peerOnly = buildInjectionText({
      seatBound: true,
      connected: true,
      seatRef: "n3",
      connectedTargets: [{ id: "peer-2", kind: "agent", summary: "Grok seat", ports: peerPorts }],
    });
    expect(peerOnly).toContain("## Worked examples");
    expect(peerOnly).toContain(
      "junto blocked 'Need the staging API key to run the deploy check.' --detail",
    );
    expect(peerOnly).not.toContain('junto escalate {"target"');
    expect(peerOnly).not.toContain("junto tasks claim");
    expect(peerOnly).not.toContain('tasks claim {"target"');
  });

  it("never promises worked examples to isolated seats", () => {
    const body = buildInjectionText({ seatBound: true, connected: false, seatRef: "n3" });
    expect(body).not.toContain("Worked examples");
  });
});

/**
 * `planEdgeMapChanges` builds its adjacency from a node index and short-circuits
 * on documents whose edge input is unchanged. Both are performance shape, so the
 * contract is pinned against a direct reimplementation of the naive walk: the
 * answers must agree on every document pair, including the ones that make an
 * index and a linear scan disagree.
 */
describe("edge-map diff equivalence", () => {
  type Doc = CanvasDoc;

  /**
   * The naive walk, restated: a linear `find` per edge endpoint and per seat
   * probe. Deliberately not shared with the implementation — a reference that
   * imports the thing it checks proves nothing.
   */
  const referencePlan = (previous: Doc, next: Doc) => {
    const slot: Readonly<Record<string, string | undefined>> = {
      agent: "msg",
      page: "browser",
    };
    const adjacency = (doc: Doc): Map<string, { id: string; kind?: string }[]> => {
      const out = new Map<string, { id: string; kind?: string }[]>();
      for (const edge of doc.edges) {
        for (const [a, b] of [
          [edge.fromNode, edge.toNode],
          [edge.toNode, edge.fromNode],
        ] as const) {
          const node = doc.nodes.find((n) => n.id === b);
          if (!node) continue;
          const kind = node.ether?.entity?.kind;
          if (kind === undefined || slot[kind] === undefined) continue;
          const list = out.get(a);
          const target = { id: b, ...(kind !== undefined ? { kind } : {}) };
          if (list) list.push(target);
          else out.set(a, [target]);
        }
      }
      return out;
    };
    const before = adjacency(previous);
    const after = adjacency(next);
    const isSeat = (doc: Doc, id: string): boolean =>
      doc.nodes.find((n) => n.id === id)?.ether?.entity?.kind === "agent";
    const key = (t: { id: string; kind?: string }): string => `${t.kind ?? ""}:${t.id}`;
    const changes: Array<{ seatId: string; added: unknown[]; removed: unknown[] }> = [];
    for (const seatId of new Set([...before.keys(), ...after.keys()])) {
      if (!isSeat(next, seatId) && !isSeat(previous, seatId)) continue;
      const prev = new Set((before.get(seatId) ?? []).map(key));
      const nextSet = new Set((after.get(seatId) ?? []).map(key));
      const added = (after.get(seatId) ?? []).filter((t) => !prev.has(key(t)));
      const removed = (before.get(seatId) ?? []).filter((t) => !nextSet.has(key(t)));
      if (added.length === 0 && removed.length === 0) continue;
      changes.push({
        seatId,
        added: [...added].sort((a, b) => a.id.localeCompare(b.id)),
        removed: [...removed].sort((a, b) => a.id.localeCompare(b.id)),
      });
    }
    return changes.sort((a, b) => a.seatId.localeCompare(b.seatId));
  };

  const node = (id: string, kind?: string, x = 0): CanvasDoc["nodes"][number] =>
    ({
      id,
      type: "text",
      text: id,
      x,
      y: 0,
      width: 1,
      height: 1,
      ...(kind === undefined ? {} : { ether: { entity: { kind } } }),
    }) as CanvasDoc["nodes"][number];

  const doc = (
    nodes: CanvasDoc["nodes"],
    edges: Array<[string, string]>,
  ): CanvasDoc =>
    ({
      nodes,
      edges: edges.map(([fromNode, toNode], i) => ({ id: `e${i}`, fromNode, toNode })),
    }) as CanvasDoc;

  const seats = [node("seat-a", "agent"), node("seat-b", "agent")];
  const sinks = [node("n-peer", "agent"), node("n-page", "page"), node("n-other", "agent")];
  /** Kind with no slot, and a node carrying no entity at all. */
  const inert = [node("n-note", "note"), node("n-bare")];

  const cases: Array<[string, CanvasDoc, CanvasDoc]> = [
    [
      "edge added to a seat",
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-peer"]]),
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-peer"], ["seat-a", "n-page"]]),
    ],
    [
      "edge reversed — the diff is undirected",
      doc([...seats, ...sinks], [["seat-a", "n-peer"]]),
      doc([...seats, ...sinks], [["n-peer", "seat-a"]]),
    ],
    [
      "endpoint node deleted out from under its edges",
      doc([...seats, ...sinks], [["seat-a", "n-peer"], ["seat-a", "n-page"]]),
      doc([...seats, node("n-page", "page")], [["seat-a", "n-peer"], ["seat-a", "n-page"]]),
    ],
    [
      "edge to an id no node carries",
      doc([...seats, ...sinks], [["seat-a", "n-peer"]]),
      doc([...seats, ...sinks], [["seat-a", "n-peer"], ["seat-a", "n-ghost"]]),
    ],
    [
      "duplicate node id — the first occurrence decides",
      doc(
        [node("dup", "agent"), node("dup", "page"), ...sinks],
        [["dup", "n-peer"]],
      ),
      doc(
        [node("dup", "agent"), node("dup", "page"), ...sinks],
        [["dup", "n-peer"], ["dup", "n-page"]],
      ),
    ],
    [
      "seat-to-seat edge — both endpoints are seats",
      doc([...seats, ...sinks], []),
      doc([...seats, ...sinks], [["seat-a", "seat-b"]]),
    ],
    [
      "self edge on a seat",
      doc([...seats, ...sinks], []),
      doc([...seats, ...sinks], [["seat-a", "seat-a"]]),
    ],
    [
      "inert kinds churn without moving a grant",
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-note"], ["seat-a", "n-peer"]]),
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-bare"], ["seat-a", "n-peer"]]),
    ],
    [
      "node changes kind while every edge stays put",
      doc([...seats, node("swing", "note")], [["seat-a", "swing"]]),
      doc([...seats, node("swing", "agent")], [["seat-a", "swing"]]),
    ],
    [
      "a node moves and nothing else",
      doc([...seats, ...sinks], [["seat-a", "n-peer"]]),
      doc([node("seat-a", "agent", 900), node("seat-b", "agent"), ...sinks], [["seat-a", "n-peer"]]),
    ],
  ];

  for (const [label, previous, next] of cases) {
    it(`agrees with the naive walk: ${label}`, () => {
      expect(planEdgeMapChanges(previous, next)).toEqual(referencePlan(previous, next));
      // The diff is antisymmetric, so run it the other way too.
      expect(planEdgeMapChanges(next, previous)).toEqual(referencePlan(next, previous));
    });
  }

  it("still reports a grant change when only a node kind moved", () => {
    const before = doc([...seats, node("swing", "note")], [["seat-a", "swing"]]);
    const after = doc([...seats, node("swing", "agent")], [["seat-a", "swing"]]);
    const changes = planEdgeMapChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].seatId).toBe("seat-a");
    expect(changes[0].added.map((t) => t.id)).toEqual(["swing"]);
  });
});
