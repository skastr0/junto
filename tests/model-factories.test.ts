/**
 * New nodes as the model holds them: every one is a node the contract accepts,
 * a new seat is never an overseer, and a region's defaults reach what is made
 * inside it.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "../src/shared/features";
import { asCanvasName, decodeCommand, type Node } from "../src/shared/model";
import { canvasFromOpened, type Canvas } from "../src/shared/model/canvas";
import { nodeFromDocument } from "../src/shared/model/from-document";
import { added, topZ } from "../src/renderer/lib/model-edits";
import {
  centreOf,
  newArtifacts,
  newBoard,
  newCron,
  newGit,
  newImage,
  newLabel,
  newNote,
  newPad,
  newPage,
  newRegion,
  newRelay,
  newRequests,
  newSeat,
  newSheet,
  newTaskBoard,
  newTerminal,
  regionCwdAt,
  regionPageStartAt,
  seatParts,
} from "../src/renderer/lib/model-factories";
import { buildManagedAgentSeat, makeManagedAgentNode } from "../src/renderer/lib/node-factories";

const name = asCanvasName("factory");
const canvasOf = (nodes: Node[]): Canvas => canvasFromOpened({ canvas: name, seq: 0, nodes, wires: [] });
const empty = canvasOf([]);
const spot = { x: 10.4, y: 20.6, z: 7 };

const region = (id: string, rect: { x: number; y: number; width: number; height: number }, defaults?: unknown): Node =>
  ({ kind: "region", id, ...rect, z: 0, hold: false, ...(defaults ? { defaults } : {}) }) as unknown as Node;

describe("new nodes", () => {
  // A kind this build has off cannot be made; its case runs in the all-on profile.
  const on = (enabled: boolean, label: string, make: () => Node): ReadonlyArray<readonly [string, () => Node]> =>
    enabled ? [[label, make]] : [];
  const made: ReadonlyArray<readonly [string, () => Node]> = [
    ["note", () => newNote(spot)],
    ["label", () => newLabel(spot)],
    ["image", () => newImage(spot, "junto-content://sha/abc")],
    ["region", () => newRegion(spot)],
    ["git", () => newGit(spot, "/repo", "junto")],
    ["seat", () => newSeat(spot, { harness: "claude", host: "local" })],
    ["terminal", () => newTerminal(spot, { launch: { kind: "shell", cwd: "/work" } })],
    ["page", () => newPage(spot, "https://example.com")],
    ...on(TASKS_ENABLED, "task board", () => newTaskBoard(spot)),
    ...on(REQUESTS_ENABLED, "requests", () => newRequests(spot)),
    ...on(ARTIFACTS_ENABLED, "artifacts", () => newArtifacts(spot)),
    ...on(BOARD_ENABLED, "board", () => newBoard(spot)),
    ...on(PAD_ENABLED, "pad", () => newPad(spot)),
    ...on(SHEET_ENABLED, "sheet", () => newSheet(spot)),
    ["cron", () => newCron(spot, "local")],
    ["relay", () => newRelay(spot, "local")],
  ];

  it.each(made)("a new %s is one the contract accepts, at whole numbers and the z it was given", (_label, make) => {
    const node = make();
    const [command] = added(empty, [node]);
    expect(command).toBeDefined();
    const exit = Effect.runSyncExit(decodeCommand(command));
    if (!Exit.isSuccess(exit)) throw new Error(`the contract refuses ${JSON.stringify(node)}`);
    expect(node).toMatchObject({ x: 10, y: 21, z: 7 });
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
  });

  it("mints a different id each time", () => {
    expect(newNote(spot).id).not.toBe(newNote(spot).id);
    expect(newTerminal(spot).bindingId).not.toBe(newTerminal(spot).bindingId);
  });

  it("stacks a new node above what is there", () => {
    const canvas = canvasOf([newNote({ x: 0, y: 0, z: 41 })]);
    expect(newNote({ x: 0, y: 0, z: topZ(canvas) }).z).toBe(42);
  });

  it("refuses a host that is not one", () => {
    expect(() => newCron(spot, "not a host")).toThrow();
    expect(() => newSeat(spot, { harness: "claude", host: "" })).toThrow();
  });
});

describe("a new seat", () => {
  it("is never an overseer and detaches when removed", () => {
    expect(newSeat(spot, { harness: "claude", host: "local" })).toMatchObject({
      kind: "agent", overseer: false, onRemove: "detach", host: "local", harness: "claude",
      agentKey: "local:claude",
    });
  });

  it("is named by the operator's label, else by its dials", () => {
    expect(seatParts({ harness: "claude", host: "local", label: "  planner " }).label).toBe("planner");
    const dialled = seatParts({ harness: "claude", host: "local", model: "opus" }).label;
    expect(dialled).toContain("opus");
    expect(dialled).not.toContain("\n");
  });

  it("starts in the directory it was given", () => {
    expect(seatParts({ harness: "claude", host: "local", cwd: "/work/junto" }).launch).toMatchObject({
      kind: "harness", cwd: "/work/junto",
    });
  });

  it("is the same seat the document path makes, apart from what is minted", () => {
    const choices = { harness: "claude", host: "local", model: "opus", cwd: "/work", label: "planner" } as const;
    const parts = seatParts(choices);
    const old = buildManagedAgentSeat(choices);
    expect(old.text).toBe(parts.label);
    expect(old.ether.entity).toEqual({ kind: "agent", name: parts.agentKey });
    expect(old.ether.host).toBe(parts.host);
    expect(old.ether.terminal?.harness).toBe(parts.harness);
    // The session id is minted per seat and rides in the arguments; compare around it.
    const strip = (argv: ReadonlyArray<string> | undefined, id: string | undefined) =>
      (argv ?? []).map((arg) => (id !== undefined && arg.includes(id) ? arg.replace(id, "<session>") : arg));
    expect(strip(old.ether.terminal?.launch?.argv, old.ether.terminal?.sessionId)).toEqual(
      strip(parts.launch.argv, parts.sessionId),
    );
    expect(old.ether.terminal?.sessionId === undefined).toBe(parts.sessionId === undefined);
  });

  it("reads back from a document seat as the same kind of node", () => {
    const doc = makeManagedAgentNode(10, 20, { harness: "claude", host: "local", label: "planner" });
    const fromDocument = nodeFromDocument("factory", doc, 7);
    const fresh = newSeat({ x: 10, y: 20, z: 7 }, { harness: "claude", host: "local", label: "planner" });
    const shape = (node: Node) => {
      if (node.kind !== "agent") throw new Error("expected a seat");
      const { id: _id, bindingId: _binding, sessionId: _session, launch: _launch, ...rest } = node;
      return rest;
    };
    expect(shape(fresh)).toEqual(shape(fromDocument));
  });
});

describe("what a region gives to what is made inside it", () => {
  const canvas = canvasOf([
    region("outer", { x: 0, y: 0, width: 2000, height: 1400 }, {
      paths: { local: "/work/outer", studio: "/srv/outer" },
      page: { url: "https://outer.example", profile: "work" },
    }),
    region("inner", { x: 100, y: 100, width: 600, height: 400 }, {
      paths: { local: " /work/inner " },
      page: { profile: "personal" },
    }),
    region("bare", { x: 150, y: 150, width: 100, height: 100 }),
  ]);

  it("gives the directory of the innermost region that names one for the host", () => {
    expect(regionCwdAt(canvas, 200, 200, "local")).toBe("/work/inner");
    expect(regionCwdAt(canvas, 1500, 1000, "local")).toBe("/work/outer");
    expect(regionCwdAt(canvas, 200, 200, "studio")).toBe("/srv/outer");
    expect(regionCwdAt(canvas, 200, 200, "elsewhere")).toBeUndefined();
    expect(regionCwdAt(canvas, 5000, 5000, "local")).toBeUndefined();
    expect(regionCwdAt(canvas, 200, 200, " ")).toBeUndefined();
  });

  it("gives the whole of the innermost region's page defaults, never a mix", () => {
    expect(regionPageStartAt(canvas, 200, 200)).toEqual({ profile: "personal" });
    expect(regionPageStartAt(canvas, 1500, 1000)).toEqual({ url: "https://outer.example", profile: "work" });
    expect(regionPageStartAt(canvas, 5000, 5000)).toBeUndefined();
  });

  it("reads the region at the centre of the new node", () => {
    const terminal = newTerminal({ x: 80, y: 90, z: 0 });
    const at = centreOf(terminal);
    expect(regionCwdAt(canvas, at.x, at.y, "local")).toBe("/work/inner");
    expect(regionCwdAt(canvas, terminal.x, terminal.y, "local")).toBe("/work/outer");
  });
});
