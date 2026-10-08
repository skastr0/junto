/**
 * New nodes as the model holds them: every one is a node the contract accepts,
 * and a new seat is never an overseer.
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
import { added, topZ } from "../src/renderer/lib/model-edits";
import {
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
} from "../src/renderer/lib/model-factories";
import { seatParts } from "../src/shared/model/seat-parts";

const name = asCanvasName("factory");
const canvasOf = (nodes: Node[]): Canvas => canvasFromOpened({ canvas: name, seq: 0, nodes, wires: [] });
const empty = canvasOf([]);
const spot = { x: 10.4, y: 20.6, z: 7 };

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

});
