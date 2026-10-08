// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { asCanvasName, asNodeId, type NodeOf, type Wire } from "../src/shared/model";
import { canvasOf, note as noteNode, region as regionNode, wire as modelWire } from "./support/model-nodes";
import { Result } from "effect";
import { decodeSquadBody, type SquadBody, type SquadSeat } from "../src/shared/squads";
import { portraitCharacter } from "../src/shared/agent-portrait";
import { resolvedPortrait } from "../src/renderer/lib/agent-profiles";
import { SquadDialogHost } from "../src/renderer/components/squads/SquadDialog";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { closeSaveSquad, openSaveSquad, placeSquadAt, squads$ } from "../src/renderer/lib/squads-state";
import { placeProfileInSlot, profiles$ } from "../src/renderer/lib/profiles-state";
import { flushPendingCanvasSave, undo } from "../src/renderer/lib/mutations";
import { newSeat } from "../src/renderer/lib/model-factories";
import {
  SQUAD_REGION_PAD,
  captureSquad,
  placeSquad,
  squadBounds,
  squadOrigin,
  squadSummary,
  type SquadIds,
} from "../src/renderer/lib/squads";

const seat = (id: string, x: number, y: number, harness: "claude" | "codex" = "claude"): NodeOf<"agent"> => ({
  ...newSeat({ x, y, z: 0 }, {
    harness,
    host: "local",
    cwd: "~/work",
    label: id,
    ...(harness === "claude" ? { model: "opus", effort: "high" } : {}),
  }),
  id: asNodeId(id),
});

const LAUNCH = { host: "local", cwd: "~/elsewhere" } as const;
const empty = canvasOf([]);
const note = (id: string, x: number, y: number) => noteNode(id, id, { x, y });
const edge = (id: string, from: string, to: string, more: Partial<Wire> = {}): Wire =>
  modelWire(id, from, to, "messages", more);

const counter = (): SquadIds => {
  let n = 0;
  return { edgeId: () => `edge-${(n += 1)}` };
};

const alpha = seat("alpha", 100, 100);
const beta = seat("beta", 500, 160, "codex");
const doc = canvasOf([note("memo", 0, 0), alpha, beta], [
  edge("ab", "alpha", "beta", { fromSide: "right", toSide: "left", mask: ["msg.send"] }),
]);

describe("captureSquad", () => {
  it("returns null without an agent seat", () => {
    expect(captureSquad(doc, ["memo"])).toBeNull();
    expect(captureSquad(doc, [])).toBeNull();
  });

  it("captures each seat as a profile, in paint order, with layout relative to the top-left", () => {
    const squad = captureSquad(doc, ["beta", "memo", "alpha"])!;
    expect(squad.seats.map((s) => [s.key, s.profile.name, s.profile.harness, s.dx, s.dy])).toEqual([
      ["s0", "alpha", "claude", 0, 0],
      ["s1", "beta", "codex", 400, 60],
    ]);
    expect(squad.seats[0]!.profile).toMatchObject({ model: "opus", effort: "high" });
    // The folder, host, and session belong to the placement, not the profile.
    expect(squad.seats[0]!.profile).not.toHaveProperty("cwd");
  });

  it("captures the seat's soul and instructions", () => {
    const squad = captureSquad(doc, ["alpha"], {
      guidanceOf: (id) => (id === "alpha" ? { soul: "Careful.", instructions: "Test first." } : undefined),
    })!;
    expect(squad.seats[0]!.profile).toMatchObject({ soul: "Careful.", instructions: "Test first." });
  });

  it("keeps connections among captured seats only, with their shape", () => {
    const squad = captureSquad(doc, ["alpha", "beta", "memo"])!;
    expect(squad.edges).toEqual([
      { from: "s0", to: "s1", verb: "messages", fromSide: "right", toSide: "left", mask: ["msg.send"] },
    ]);
  });

  it("captures the fully resolved portrait, override included", () => {
    const squad = captureSquad(doc, ["alpha"], { portraitOf: () => ({ eyes: "dot" }) })!;
    const resolved = portraitCharacter("alpha", { eyes: "dot" });
    expect(squad.seats[0]!.profile.portrait).toMatchObject({ eyes: resolved.eyes, shape: resolved.shape, bodyHue: resolved.bodyHue });
  });

  it("produces a body the stored schema admits", () => {
    const squad = captureSquad(doc, ["alpha", "beta"])!;
    expect(decodeSquadBody(JSON.parse(JSON.stringify(squad)))._tag).toBe("Success");
  });
});

describe("decodeSquadBody", () => {
  it("converts a squad saved before profiles forward, recovering the harness dials", () => {
    const legacy = {
      seats: [
        {
          key: "s0",
          harness: "claude",
          label: "reviewer",
          entityName: "local:claude",
          host: "local",
          launch: { argv: ["claude", "--model", "opus", "--effort", "high", "--session-id", "{squad-session}"], cwd: "~/old" },
          pinSession: true,
          dx: 0,
          dy: 0,
          width: 240,
          height: 96,
          portrait: { eyes: "dot" },
          prompt: "Say hello.",
        },
      ],
      edges: [],
    };
    const decoded = decodeSquadBody(legacy);
    expect(Result.isSuccess(decoded)).toBe(true);
    const seat0 = Result.getOrThrow(decoded).seats[0]!;
    expect(seat0).toMatchObject({ key: "s0", dx: 0, width: 240 });
    expect(seat0).not.toHaveProperty("prompt");
    expect(seat0.profile).toEqual({ name: "reviewer", harness: "claude", model: "opus", effort: "high", portrait: { eyes: "dot" } });
  });

  it("reads a squad saved with opening prompts as one without them", () => {
    const stored = {
      seats: [{ key: "s0", profile: { name: "alpha", harness: "claude" }, dx: 0, dy: 0, width: 240, height: 96, prompt: "Wait." }],
      edges: [],
      prompt: "Read the README.",
    };
    const decoded = Result.getOrThrow(decodeSquadBody(stored));
    expect(decoded).toEqual({
      seats: [{ key: "s0", profile: { name: "alpha", harness: "claude" }, dx: 0, dy: 0, width: 240, height: 96 }],
      edges: [],
    });
  });

  it("drops members without a usable profile and fails an empty squad", () => {
    const body = { seats: [{ key: "s0", profile: { name: "" }, dx: 0, dy: 0, width: 1, height: 1 }], edges: [] };
    expect(Result.isFailure(decodeSquadBody(body))).toBe(true);
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
  const squad = captureSquad(doc, ["alpha", "beta"])!;

  it("mints fresh seats, remaps connections, and offsets the layout to the point", () => {
    const placed = placeSquad(squad, { x: 2000, y: 1000 }, empty, counter(), LAUNCH);
    const { width, height } = squadBounds(squad);
    const origin = { x: Math.round(2000 - width / 2), y: Math.round(1000 - height / 2) };
    expect(placed.nodes.map((n) => [n.x - origin.x, n.y - origin.y])).toEqual([
      [0, 0],
      [400, 60],
    ]);
    const ids = placed.nodes.map((n) => n.id);
    expect(ids).not.toContain("alpha");
    expect(new Set(placed.nodes.map((n) => n.bindingId)).size).toBe(2);
    expect(placed.edges).toHaveLength(1);
    expect(placed.edges[0]).toMatchObject({ from: ids[0], to: ids[1], verb: "messages", mask: ["msg.send"] });
    expect(placed.regionId).toBeUndefined();
  });

  it("mints each seat from its profile: same harness and dials, fresh binding, the launch folder", () => {
    const placed = placeSquad(squad, { x: 0, y: 0 }, empty, counter(), LAUNCH);
    const terminal = placed.nodes[0]!;
    expect(terminal.harness).toBe("claude");
    expect(terminal.label).toBe("alpha");
    expect(terminal.launch?.argv).toEqual(expect.arrayContaining(["--model", "opus"]));
    expect(terminal.launch?.cwd).toBe("~/elsewhere");
    const again = placeSquad(squad, { x: 0, y: 0 }, empty, counter(), LAUNCH);
    expect(new Set([...placed.nodes, ...again.nodes].map((n) => n.id)).size).toBe(4);
  });

  it("asks for a folder instead of minting seats that cannot start", () => {
    const placed = placeSquad(squad, { x: 0, y: 0 }, empty, counter(), { host: "local" });
    expect(placed.needsFolder).toBe(true);
    expect(placed.nodes).toEqual([]);
  });

  it("copies soul and instructions to the new seats", () => {
    const guided = captureSquad(doc, ["alpha"], { guidanceOf: () => ({ soul: "Calm." }) })!;
    const placed = placeSquad(guided, { x: 0, y: 0 }, empty, counter(), LAUNCH);
    expect(placed.guidance[placed.nodes[0]!.id]).toEqual({ soul: "Calm." });
  });

  it("copies portraits to the new ids so they look the same", () => {
    const placed = placeSquad(squad, { x: 0, y: 0 }, empty, counter(), LAUNCH);
    const newId = placed.nodes[0]!.id;
    const drawn = portraitCharacter(newId, placed.portraits[newId]);
    const original = resolvedPortrait("alpha")!;
    expect({ shape: drawn.shape, bodyHue: drawn.bodyHue, eyes: drawn.eyes, topper: drawn.topper }).toEqual({
      shape: original.shape,
      bodyHue: original.bodyHue,
      eyes: original.eyes,
      topper: original.topper,
    });
  });

  it("lands inside a region and takes the region's folder for the host", () => {
    const region = regionNode("region", { x: 0, y: 0, width: 1200, height: 800 },
      { defaults: { paths: { local: "~/region-folder" } } });
    const placed = placeSquad(squad, { x: 1150, y: 750 }, canvasOf([region]), counter(), LAUNCH);
    expect(placed.regionId).toBe("region");
    for (const node of placed.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(SQUAD_REGION_PAD);
      expect(node.x + node.width).toBeLessThanOrEqual(1200 - SQUAD_REGION_PAD);
      expect(node.y + node.height).toBeLessThanOrEqual(800 - SQUAD_REGION_PAD);
      expect(node.launch!.cwd).toBe("~/region-folder");
    }
  });

  it("skips seats and connections this build cannot place", () => {
    const future = {
      ...squad,
      seats: [squad.seats[0]!, { ...squad.seats[1]!, profile: { ...squad.seats[1]!.profile, harness: "harness-from-later" } }],
    };
    const placed = placeSquad(future, { x: 0, y: 0 }, empty, counter(), LAUNCH);
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
    const placed = placeSquad(withEdges, { x: 0, y: 0 }, empty, counter(), LAUNCH);
    expect(placed.edges).toHaveLength(1);
    expect(placed.edges[0]).toMatchObject({ verb: "messages", mask: ["msg.send"] });
    expect(placed.edges[0]!.fromSide).toBeUndefined();
  });
});

describe("squadSummary", () => {
  it("counts agents and connections", () => {
    expect(squadSummary(captureSquad(doc, ["alpha"])!)).toBe("1 agent");
    expect(squadSummary(captureSquad(doc, ["alpha", "beta"])!)).toBe("2 agents, 1 connection");
  });
});


describe("native squad and profile gestures", () => {
  const name = "squad-native-gestures";
  let root: Root, host: HTMLDivElement, release: () => void;
  let oldApi: typeof window.junto;
  let oldCanvas: string;
  let send: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    oldApi = window.junto; oldCanvas = state$.canvasName.peek();
    state$.canvasName.set(name);
    release = modelStore.adopt({ canvas: asCanvasName(name), seq: 0, nodes: [...doc.nodes.values()], wires: [...doc.wires.values()] });
    send = vi.fn(async () => ({ seq: 1 }));
    save = vi.fn(async (input: { name: string; body: SquadBody }) => ({ ok: true,
      squad: { ...input.body, name: input.name, squadId: "saved", createdAt: 1, updatedAt: 1 } }));
    (window as unknown as { junto: unknown }).junto = { modelCommand: send, squadSave: save,
      portraitOverrideSet: async (_id: string, override: unknown) => ({ ok: true, override }) };
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); await flush(); }); host.remove();
    closeSaveSquad(); squads$.list.set([]); profiles$.list.set([]); release();
    modelStore.canvas$(name).nodes.set({}); modelStore.canvas$(name).wires.set({});
    state$.canvasName.set(oldCanvas);
    (window as unknown as { junto: unknown }).junto = oldApi;
    vi.unstubAllGlobals();
  });

  it("mounted squad preview and save follow native selections without a document copy", async () => {
    openSaveSquad(["alpha", "beta"]);
    await act(async () => { root.render(createElement(SquadDialogHost)); await flush(); });
    expect(document.body.textContent).toContain("2 agents, 1 connection");
    await act(async () => { modelStore.node$(name, "beta").delete(); await flush(); });
    expect(document.body.textContent).toContain("1 agent");
    const input = document.querySelector<HTMLInputElement>('[aria-label="Squad name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Reviewers");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { document.querySelector("form.squad-dialog")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush(); });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].body.seats.map((seat: SquadSeat) => seat.profile.name)).toEqual(["alpha"]);
  });

  it("places a native squad as one undoable Add batch with remapped wires", async () => {
    const body = captureSquad(doc, ["alpha", "beta"])!;
    squads$.list.set([{ ...body, name: "Team", squadId: "team", createdAt: 1, updatedAt: 1 }]);
    expect(await placeSquadAt("team", { x: 2000, y: 1000 }, LAUNCH)).toBe("placed");
    await flushPendingCanvasSave();
    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]![0];
    expect(command).toMatchObject({ _tag: "Add", canvas: name });
    expect(command.nodes.map((node: NodeOf<"agent">) => node.kind)).toEqual(["agent", "agent"]);
    expect(command.wires[0]).toMatchObject({ from: command.nodes[0].id, to: command.nodes[1].id, verb: "messages", mask: ["msg.send"] });
    expect(command.nodes[0].z).toBeGreaterThan(beta.z);
    undo(); await flushPendingCanvasSave();
    expect(send.mock.calls[1]![0]).toMatchObject({ _tag: "Remove", nodes: command.nodes.map((node: NodeOf<"agent">) => node.id), wires: [command.wires[0].id] });
  });

  it("places a native profile with an Add command, without serializing a document", async () => {
    profiles$.list.set([{ name: "Solo", harness: "codex", profileId: "solo", createdAt: 1, updatedAt: 1 }]);
    expect(await placeProfileInSlot("solo", () => ({ x: 700, y: 800 }), LAUNCH)).toBe("placed");
    await flushPendingCanvasSave();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ _tag: "Add", canvas: name, nodes: [{ kind: "agent", label: "Solo", x: 700, y: 800 }], wires: [] });
  });
});
