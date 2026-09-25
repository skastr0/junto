import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../src/shared/canvas";
import { SQUAD_SESSION_TOKEN, decodeSquadBody } from "../src/shared/squads";
import { portraitCharacter } from "../src/shared/agent-portrait";
import { makeManagedAgentNode, makeGroupNode } from "../src/renderer/lib/node-factories";
import {
  SQUAD_REGION_PAD,
  captureSquad,
  placeSquad,
  resolvedSquadPortrait,
  squadBounds,
  squadOrigin,
  squadSummary,
  tokenizeSession,
  type SquadIds,
} from "../src/renderer/lib/squads";

const seat = (id: string, x: number, y: number, harness: "claude" | "codex" = "claude"): TextNode => ({
  ...makeManagedAgentNode(x, y, { harness, host: "local", cwd: "~/work", label: id }),
  id,
});

const note = (id: string, x: number, y: number): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x,
  y,
  width: 200,
  height: 80,
});

const edge = (id: string, fromNode: string, toNode: string, extra: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id,
  fromNode,
  toNode,
  ether: { verb: "messages" },
  ...extra,
});

const counter = (): SquadIds => {
  let n = 0;
  const next = (prefix: string) => () => `${prefix}-${(n += 1)}`;
  return { nodeId: next("node"), bindingId: next("bind"), edgeId: next("edge"), sessionId: next("sess") };
};

const alpha = seat("alpha", 100, 100);
const beta = seat("beta", 500, 160, "codex");
const doc: CanvasDoc = {
  nodes: [note("memo", 0, 0), alpha, beta],
  edges: [
    edge("ab", "alpha", "beta", { fromSide: "right", toSide: "left", label: "hand-off" }),
    edge("am", "alpha", "memo"),
  ],
};

describe("captureSquad", () => {
  it("returns null without an agent seat", () => {
    expect(captureSquad(doc, ["memo"])).toBeNull();
    expect(captureSquad(doc, [])).toBeNull();
  });

  it("keeps only agent seats, in document order, with layout relative to the top-left", () => {
    const squad = captureSquad(doc, ["beta", "memo", "alpha"])!;
    expect(squad.seats.map((s) => [s.key, s.label, s.harness, s.dx, s.dy])).toEqual([
      ["s0", "alpha", "claude", 0, 0],
      ["s1", "beta", "codex", 400, 60],
    ]);
    expect(squad.seats[0]).toMatchObject({ host: "local", entityName: "local:claude", launch: { cwd: "~/work" } });
  });

  it("keeps connections among captured seats only, with their shape", () => {
    const squad = captureSquad(doc, ["alpha", "beta", "memo"])!;
    expect(squad.edges).toEqual([
      { from: "s0", to: "s1", verb: "messages", fromSide: "right", toSide: "left", label: "hand-off" },
    ]);
  });

  it("swaps a pinned session id for the token, and leaves capture harnesses alone", () => {
    const squad = captureSquad(doc, ["alpha", "beta"])!;
    const [claude, codex] = squad.seats;
    expect(claude?.pinSession).toBe(true);
    expect(claude?.launch.argv).toContain(SQUAD_SESSION_TOKEN);
    expect(claude?.launch.argv.join(" ")).not.toContain(alpha.ether!.terminal!.sessionId!);
    expect(codex?.pinSession).toBeUndefined();
  });

  it("captures the fully resolved portrait, override included", () => {
    const squad = captureSquad(doc, ["alpha"], { portraitOf: (id) => (id === "alpha" ? { topper: "cat" } : undefined) })!;
    const portrait = squad.seats[0]!.portrait!;
    const character = portraitCharacter("alpha", { topper: "cat" });
    expect(portrait.topper).toBe(character.topper);
    expect(portrait.bodyHue).toBe(character.bodyHue);
    expect(portrait.temperament).toBe(character.temperament);
  });

  it("records trimmed opening prompts for the squad and per seat", () => {
    const squad = captureSquad(doc, ["alpha", "beta"], {
      prompt: "  Read the README.  ",
      seatPrompts: { beta: "Review what alpha writes.", alpha: "   " },
    })!;
    expect(squad.prompt).toBe("Read the README.");
    expect(squad.seats[0]?.prompt).toBeUndefined();
    expect(squad.seats[1]?.prompt).toBe("Review what alpha writes.");
  });

  it("produces a body the stored schema admits", () => {
    const squad = captureSquad(doc, ["alpha", "beta"], { prompt: "go" })!;
    expect(decodeSquadBody(JSON.parse(JSON.stringify(squad)))._tag).toBe("Success");
  });
});

describe("tokenizeSession", () => {
  it("replaces bare and flag=value forms", () => {
    expect(tokenizeSession(["x", "--session-id", "abc", "--resume=abc"], "abc")).toEqual({
      argv: ["x", "--session-id", SQUAD_SESSION_TOKEN, `--resume=${SQUAD_SESSION_TOKEN}`],
      pinned: true,
    });
    expect(tokenizeSession(["x"], undefined)).toEqual({ argv: ["x"], pinned: false });
    expect(tokenizeSession(["x"], "abc")).toEqual({ argv: ["x"], pinned: false });
  });
});

describe("squadOrigin", () => {
  const size = { width: 400, height: 200 };

  it("centers on the point on open canvas", () => {
    expect(squadOrigin(size, { x: 1000, y: 500 })).toEqual({ x: 800, y: 400 });
  });

  it("moves the squad fully inside a region it fits", () => {
    const region = { x: 0, y: 0, width: 800, height: 600 };
    expect(squadOrigin(size, { x: 790, y: 590 }, region)).toEqual({
      x: 800 - SQUAD_REGION_PAD - 400,
      y: 600 - SQUAD_REGION_PAD - 200,
    });
    expect(squadOrigin(size, { x: 5, y: 5 }, region)).toEqual({ x: SQUAD_REGION_PAD, y: SQUAD_REGION_PAD });
  });

  it("starts at the region's corner when the squad is larger", () => {
    const small = { x: 100, y: 100, width: 300, height: 150 };
    expect(squadOrigin(size, { x: 200, y: 150 }, small)).toEqual({
      x: 100 + SQUAD_REGION_PAD,
      y: 100 + SQUAD_REGION_PAD,
    });
  });
});

describe("placeSquad", () => {
  const squad = captureSquad(doc, ["alpha", "beta"], { prompt: "Say hello.", seatPrompts: { beta: "Wait for alpha." } })!;

  it("mints fresh seats, remaps connections, and offsets the layout to the point", () => {
    const placed = placeSquad(squad, { x: 2000, y: 1000 }, { nodes: [], edges: [] }, counter());
    const { width, height } = squadBounds(squad);
    const origin = { x: Math.round(2000 - width / 2), y: Math.round(1000 - height / 2) };
    expect(placed.nodes.map((n) => [n.x - origin.x, n.y - origin.y])).toEqual([
      [0, 0],
      [400, 60],
    ]);
    const ids = placed.nodes.map((n) => n.id);
    expect(ids).not.toContain("alpha");
    expect(new Set(placed.nodes.map((n) => n.ether!.terminal!.bindingId)).size).toBe(2);
    expect(placed.edges).toHaveLength(1);
    expect(placed.edges[0]).toMatchObject({ fromNode: ids[0], toNode: ids[1], ether: { verb: "messages" }, label: "hand-off" });
    expect(placed.regionId).toBeUndefined();
  });

  it("gives a pinned seat a new session in both argv and the terminal", () => {
    const placed = placeSquad(squad, { x: 0, y: 0 }, { nodes: [], edges: [] }, counter());
    const terminal = placed.nodes[0]!.ether!.terminal!;
    expect(terminal.sessionId).toMatch(/^sess-/);
    expect(terminal.launch?.argv).toContain(terminal.sessionId);
    expect(terminal.launch?.argv).not.toContain(SQUAD_SESSION_TOKEN);
    expect(placed.nodes[1]!.ether!.terminal!.sessionId).toBeUndefined();
  });

  it("two placements never share an id or a session", () => {
    const ids = counter();
    const first = placeSquad(squad, { x: 0, y: 0 }, { nodes: [], edges: [] }, ids);
    const second = placeSquad(squad, { x: 0, y: 0 }, { nodes: [], edges: [] }, ids);
    const all = [...first.nodes, ...second.nodes];
    expect(new Set(all.map((n) => n.id)).size).toBe(4);
    expect(first.nodes[0]!.ether!.terminal!.sessionId).not.toBe(second.nodes[0]!.ether!.terminal!.sessionId);
  });

  it("copies portraits to the new ids so they look the same", () => {
    const placed = placeSquad(squad, { x: 0, y: 0 }, { nodes: [], edges: [] }, counter());
    const newId = placed.nodes[0]!.id;
    const drawn = portraitCharacter(newId, placed.portraits[newId]);
    const original = resolvedSquadPortrait("alpha");
    expect({ shape: drawn.shape, bodyHue: drawn.bodyHue, eyes: drawn.eyes, topper: drawn.topper }).toEqual({
      shape: original.shape,
      bodyHue: original.bodyHue,
      eyes: original.eyes,
      topper: original.topper,
    });
  });

  it("mails each seat its own prompt, else the squad's", () => {
    const placed = placeSquad(squad, { x: 0, y: 0 }, { nodes: [], edges: [] }, counter());
    expect(placed.prompts.map((p) => p.text)).toEqual(["Say hello.", "Wait for alpha."]);
    expect(placed.prompts[0]?.bindingId).toBe(placed.nodes[0]!.ether!.terminal!.bindingId);
  });

  it("lands inside a region and takes the region's folder for the host", () => {
    const region = {
      ...makeGroupNode(0, 0, { width: 1200, height: 800 }),
      id: "region",
      ether: { region: { defaults: { paths: { local: "~/region-folder" } } } },
    } as CanvasNode;
    const placed = placeSquad(squad, { x: 1150, y: 750 }, { nodes: [region], edges: [] }, counter());
    expect(placed.regionId).toBe("region");
    for (const node of placed.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(SQUAD_REGION_PAD);
      expect(node.x + node.width).toBeLessThanOrEqual(1200 - SQUAD_REGION_PAD);
      expect(node.y + node.height).toBeLessThanOrEqual(800 - SQUAD_REGION_PAD);
      expect(node.ether!.terminal!.launch!.cwd).toBe("~/region-folder");
    }
  });

  it("skips seats and connections this build cannot place", () => {
    const future = {
      ...squad,
      seats: [squad.seats[0]!, { ...squad.seats[1]!, harness: "harness-from-later" }],
    };
    const placed = placeSquad(future, { x: 0, y: 0 }, { nodes: [], edges: [] }, counter());
    expect(placed.nodes).toHaveLength(1);
    expect(placed.edges).toEqual([]);
    expect(placed.skipped).toEqual(["beta"]);
  });

  it("drops unknown verbs and never widens a mask", () => {
    const withEdges = {
      ...squad,
      edges: [
        { from: "s0", to: "s1", verb: "verb-from-later" },
        { from: "s0", to: "s1", verb: "messages", mask: ["port-from-later"] },
        { from: "s1", to: "s0", verb: "messages", mask: ["msg.send", "port-from-later"], fromSide: "diagonal" },
      ],
    };
    const placed = placeSquad(withEdges, { x: 0, y: 0 }, { nodes: [], edges: [] }, counter());
    expect(placed.edges).toHaveLength(1);
    expect(placed.edges[0]!.ether).toEqual({ verb: "messages", mask: ["msg.send"] });
    expect(placed.edges[0]!.fromSide).toBeUndefined();
  });
});

describe("squadSummary", () => {
  it("counts agents and connections", () => {
    expect(squadSummary(captureSquad(doc, ["alpha"])!)).toBe("1 agent");
    expect(squadSummary(captureSquad(doc, ["alpha", "beta"])!)).toBe("2 agents, 1 connection");
  });
});
