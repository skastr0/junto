import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  decodeCanvasCopy,
  exportCanvasCopy,
  type CanvasCopy,
  type CanvasCopySource,
} from "../src/shared/canvas-copy";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, asNodeId, type Node, type Region, type Wire } from "../src/shared/model";
import { seat as seatNode, wire } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-installation");
const MINI = id("mini-installation");
const seatId = (digit: string) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`);

const region = (name: string, frame: { x: number; y: number; width: number; height: number }, more: Partial<Region> = {}): Region => ({
  kind: "region",
  id: asNodeId(name),
  z: 0,
  hold: false,
  label: name,
  ...frame,
  ...more,
});

const seat = (name: string, host: string, at: { x: number; y: number }) =>
  seatNode(name, { host: host as never, agentKey: `${host}:claude`, ...at, width: 100, height: 60 });

/**
 * Two regions side by side. `remote` holds `lead` (on the macbook) and `peer`
 * (on the mini); `private` holds only `solo`, on the macbook.
 */
const nodes: ReadonlyArray<Node> = [
  region("remote", { x: 0, y: 0, width: 1000, height: 400 }, {
    instruction: "Briefing for the remote region.",
    defaults: { paths: { macbook: "/Users/op/junto", mini: "/Users/mini/junto" } as never, page: { url: "https://example.com" } },
    contract: { rules: [] },
    environment: {
      sealed: true,
      sources: [
        { id: "everywhere", kind: "value", name: "MODE", value: "shared" },
        { id: "mini-only", kind: "secret", name: "TOKEN", secretId: "token-1", host: "mini" as never },
        { id: "macbook-only", kind: "value", name: "EDITOR_ONLY", value: "x", host: "macbook" as never },
      ],
      folders: ["~/shared"],
    },
    background: "sunset.png",
  }),
  region("private", { x: 2000, y: 0, width: 1000, height: 400 }, {
    instruction: "Briefing nobody on the mini should read.",
    environment: { sources: [{ id: "private", kind: "value", name: "PRIVATE", value: "never-sent" }] },
  }),
  seat("lead", "macbook", { x: 50, y: 50 }),
  seat("peer", "mini", { x: 300, y: 50 }),
  seat("solo", "macbook", { x: 2050, y: 50 }),
  { kind: "terminal", id: asNodeId("mini-shell"), x: 500, y: 50, width: 100, height: 60, z: 0, host: "mini" as never, bindingId: "binding-mini-shell" as never, onRemove: "detach" },
  { kind: "terminal", id: asNodeId("macbook-shell"), x: 700, y: 50, width: 100, height: 60, z: 0, host: "macbook" as never, bindingId: "binding-macbook-shell" as never, onRemove: "detach" },
  { kind: "note", id: asNodeId("a-note"), x: 50, y: 200, width: 100, height: 60, z: 0, text: "written by the operator" } as Node,
];

const wires: ReadonlyArray<Wire> = [
  wire("lead-to-peer", "lead", "peer", "messages"),
  wire("peer-to-lead", "peer", "lead", "messages"),
  wire("lead-to-solo", "lead", "solo", "messages"),
  wire("lead-to-note", "lead", "a-note", "messages"),
];

const source: CanvasCopySource = {
  canvasName: asCanvasName("factory"),
  seq: 41,
  editor: EDITOR,
  nodes,
  wires,
  guidance: {
    lead: { soul: "The lead's soul.", instructions: "The lead's instructions." },
    peer: { soul: "The peer's soul." },
  },
  briefing: "The app briefing.",
  references: [
    { name: "style", body: "App-wide style." },
    { regionId: asNodeId("remote"), name: "runbook", body: "Remote runbook." },
    { regionId: asNodeId("private"), name: "secrets-policy", body: "Private policy." },
  ],
  playing: true,
  seatIdOf: (node) => seatId(node.id === "lead" ? "1" : node.id === "peer" ? "2" : "3"),
};

const cut = (): CanvasCopy => {
  const result = exportCanvasCopy(source, { installationId: MINI, machineName: "mini" });
  if (!result.ok) throw new Error(result.refusal.reason);
  return result.copy;
};

describe("a canvas cut for one machine", () => {
  it("is one snapshot stamped with its canvas, count, editor and target, and decodes as written", () => {
    const copy = cut();
    expect(copy).toMatchObject({ canvasName: "factory", seq: 41, editor: EDITOR, target: MINI, playing: true });
    expect(Result.isSuccess(decodeCanvasCopy(JSON.parse(JSON.stringify(copy))))).toBe(true);
  });

  it("carries the machine's own seats and terminals whole, with their guidance", () => {
    const copy = cut();
    expect(copy.seats).toEqual([nodes.find((node) => node.id === "peer")]);
    expect(copy.terminals.map((terminal) => terminal.id)).toEqual(["mini-shell"]);
    expect(copy.guidance).toEqual([{ nodeId: "peer", soul: "The peer's soul." }]);
  });

  it("carries every other seat as a peer: who and where, and nothing to start it from", () => {
    const copy = cut();
    expect(copy.peers).toEqual([
      { kind: "peer", id: "lead", x: 50, y: 50, width: 100, height: 60, z: 0, label: "lead", host: "macbook", seatId: seatId("1") },
      { kind: "peer", id: "solo", x: 2050, y: 50, width: 100, height: 60, z: 0, label: "solo", host: "macbook", seatId: seatId("3") },
    ]);
    const sent = JSON.stringify(copy);
    for (const never of ["binding-lead", "binding-solo", "The lead's soul", "The lead's instructions", "macbook-shell"]) {
      expect(sent).not.toContain(never);
    }
  });

  it("gives every region as a rectangle, and its private parts only where one of the machine's seats is inside", () => {
    const copy = cut();
    const remote = copy.regions.find((held) => held.id === "remote")!;
    expect(remote).toEqual({
      kind: "region",
      id: "remote",
      x: 0,
      y: 0,
      width: 1000,
      height: 400,
      z: 0,
      label: "remote",
      hold: false,
      instruction: "Briefing for the remote region.",
      defaults: { paths: { mini: "/Users/mini/junto" } },
      contract: { rules: [] },
      environment: {
        sealed: true,
        sources: [
          { id: "everywhere", kind: "value", name: "MODE", value: "shared" },
          { id: "mini-only", kind: "secret", name: "TOKEN", secretId: "token-1", host: "mini" },
        ],
        folders: ["~/shared"],
      },
    });
    expect(copy.regions.find((held) => held.id === "private")).toEqual({
      kind: "region",
      id: "private",
      x: 2000,
      y: 0,
      width: 1000,
      height: 400,
      z: 0,
      label: "private",
      hold: false,
    });
    const sent = JSON.stringify(copy);
    for (const never of ["nobody on the mini", "never-sent", "/Users/op/junto", "EDITOR_ONLY", "sunset.png", "example.com"]) {
      expect(sent).not.toContain(never);
    }
  });

  it("carries the app briefing and app-wide references to every machine, and a region's only to its own", () => {
    const copy = cut();
    expect(copy.briefing).toBe("The app briefing.");
    expect(copy.references.map((reference) => reference.name)).toEqual(["style", "runbook"]);
  });

  it("keeps the wires between what the machine holds, and leaves notes on the editing machine", () => {
    const copy = cut();
    expect(copy.wires.map((held) => held.id)).toEqual(["lead-to-peer", "peer-to-lead", "lead-to-solo"]);
    expect(JSON.stringify(copy)).not.toContain("written by the operator");
  });

  it("is refused for the editing machine, for a machine with no seat, and while a row names no machine", () => {
    expect(exportCanvasCopy(source, { installationId: EDITOR, machineName: "macbook" })).toEqual({
      ok: false,
      refusal: { reason: "the-editing-machine-holds-the-canvas" },
    });
    expect(exportCanvasCopy(source, { installationId: id("stranger"), machineName: "stranger" })).toEqual({
      ok: false,
      refusal: { reason: "no-seat-on-that-machine" },
    });
    const unnamed = { ...source, nodes: [...nodes, seat("stray", "local", { x: 50, y: 300 })] };
    expect(exportCanvasCopy(unnamed, { installationId: MINI, machineName: "mini" })).toEqual({
      ok: false,
      refusal: { reason: "a-row-names-no-machine", nodeId: "stray" },
    });
    const unnamedFolder = {
      ...source,
      nodes: nodes.map((node) => (node.id === "private" ? { ...node, defaults: { paths: { local: "/tmp" } } } as Node : node)),
    };
    expect(exportCanvasCopy(unnamedFolder, { installationId: MINI, machineName: "mini" })).toMatchObject({
      ok: false,
      refusal: { reason: "a-row-names-no-machine", nodeId: "private" },
    });
  });
});
