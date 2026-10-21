import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  decodeCanvasCopy,
  exportCanvasCopy,
  type CanvasCopy,
  type CanvasCopySource,
} from "../src/shared/canvas-copy";
import { productNodeKindEnabled } from "../src/shared/features";
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
  { kind: "terminal", id: asNodeId("mini-shell"), x: 500, y: 50, width: 100, height: 60, z: 0, host: "mini" as never, bindingId: "binding-mini-shell" as never },
  { kind: "terminal", id: asNodeId("macbook-shell"), x: 700, y: 50, width: 100, height: 60, z: 0, host: "macbook" as never, bindingId: "binding-macbook-shell" as never },
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
  canvasId: "canvas-factory",
  seq: 41,
  editor: EDITOR,
  editorMachineName: "macbook",
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
    expect(copy).toMatchObject({ canvasName: "factory", canvasId: "canvas-factory", seq: 41, editor: EDITOR, target: MINI, playing: true });
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

/**
 * Every kind, cut for two machines: the mini, whose seat is in the region the
 * resources sit in, and linux, whose seat is in the other one. Resources cross
 * to both as their place and their label; only a region's private parts follow
 * the seats.
 */
describe("each kind, cut for each machine", () => {
  const LINUX = id("linux-installation");
  const inRemote = (x: number) => ({ x, y: 300, width: 40, height: 40, z: 2 });
  const resources: ReadonlyArray<Node> = [
    { kind: "task", id: asNodeId("backlog"), ...inRemote(10), color: "#ff0000", name: "Backlog", contract: { instructions: "Task contract body." } } as Node,
    { kind: "artifacts", id: asNodeId("shelf"), ...inRemote(60), label: "Shelf" },
    { kind: "label", id: asNodeId("caption"), ...inRemote(110), text: "Caption" },
    { kind: "file", id: asNodeId("spec"), ...inRemote(160), path: "/Users/op/private-dir/spec.md" },
    { kind: "link", id: asNodeId("docs"), ...inRemote(210), url: "https://docs.test/secret-path?token=1" },
    { kind: "git", id: asNodeId("repo"), ...inRemote(260), cwd: "/Users/op/private-repo" },
    { kind: "page", id: asNodeId("browser"), ...inRemote(310), url: "https://browser.test/secret-page", profile: "work-profile", host: "mini" as never, onRemove: "detach" },
    { kind: "note", id: asNodeId("memo"), ...inRemote(360), text: "Note body stays home." },
    { kind: "cron", id: asNodeId("nightly"), ...inRemote(410), host: "macbook" as never, label: "Nightly", expression: "0 3 * * *" },
    { kind: "relay", id: asNodeId("relay"), ...inRemote(460), host: "macbook" as never, label: "Relay" },
    { kind: "watcher", id: asNodeId("gauge"), ...inRemote(510), host: "macbook" as never, label: "Gauge" },
  ];
  const lin = seat("lin", "linux", { x: 2300, y: 50 });
  const everything: CanvasCopySource = {
    ...source,
    nodes: [...nodes, lin, ...resources],
    wires: [
      ...wires,
      wire("lead-to-backlog", "lead", "backlog", "messages"),
      wire("lead-to-browser", "lead", "browser", "messages"),
      wire("lead-to-memo", "lead", "memo", "messages"),
    ],
    seatIdOf: (node) => seatId(node.id === "lead" ? "1" : node.id === "peer" ? "2" : node.id === "solo" ? "3" : "4"),
  };
  const cutFor = (installationId: typeof MINI, machineName: string): CanvasCopy => {
    const result = exportCanvasCopy(everything, { installationId, machineName });
    if (!result.ok) throw new Error(result.refusal.reason);
    return result.copy;
  };
  const destinations = [
    { name: "the mini, with a seat in their region", copy: () => cutFor(MINI, "mini") },
    { name: "linux, with no seat in their region", copy: () => cutFor(LINUX, "linux") },
  ];
  const at = (x: number) => ({ ...inRemote(x) });

  const crosses: ReadonlyArray<readonly [Node["kind"], string, object | undefined]> = [
    ["task", "backlog", { kind: "task", id: "backlog", ...at(10), name: "Backlog" }],
    ["artifacts", "shelf", { kind: "artifacts", id: "shelf", ...at(60), label: "Shelf" }],
    ["label", "caption", { kind: "label", id: "caption", ...at(110), text: "Caption" }],
    ["file", "spec", { kind: "stub", of: "file", id: "spec", ...at(160), label: "spec.md" }],
    ["link", "docs", { kind: "stub", of: "link", id: "docs", ...at(210), label: "docs.test" }],
    ["git", "repo", { kind: "stub", of: "git", id: "repo", ...at(260), label: "private-repo" }],
    // The editing machine's name, not the row's: pages live where the canvas is edited.
    ["page", "browser", { kind: "stub", of: "page", id: "browser", ...at(310), label: "browser.test", host: "macbook" }],
    ["note", "memo", undefined],
    ["cron", "nightly", undefined],
    ["relay", "relay", undefined],
    ["watcher", "gauge", undefined],
  ];

  for (const destination of destinations) {
    describe(destination.name, () => {
      it.each(crosses)("a %s (%s)", (kind, nodeId, expected) => {
        const held = destination.copy().resources.find((resource) => resource.id === nodeId);
        expect(held).toEqual(productNodeKindEnabled(kind) ? expected : undefined);
      });

      it("carries no body, colour, path, address or profile", () => {
        const sent = JSON.stringify(destination.copy());
        for (const never of [
          "Task contract body",
          "#ff0000",
          "private-dir",
          "secret-path",
          "/Users/op/private-repo",
          "secret-page",
          "work-profile",
          "Note body stays home",
          "0 3 * * *",
        ]) {
          expect(sent).not.toContain(never);
        }
      });

      it("keeps wires to resources and drops those to a page or a note", () => {
        const held = destination.copy().wires.map((kept) => kept.id);
        expect(held).toContain("lead-to-backlog");
        expect(held).not.toContain("lead-to-browser");
        expect(held).not.toContain("lead-to-memo");
      });

      it("decodes as written", () => {
        expect(Result.isSuccess(decodeCanvasCopy(JSON.parse(JSON.stringify(destination.copy()))))).toBe(true);
      });
    });
  }

  it("gives a region's private parts only to the machine with a seat in it", () => {
    const remoteFor = (copy: CanvasCopy) => copy.regions.find((held) => held.id === "remote")!;
    expect(remoteFor(cutFor(MINI, "mini")).instruction).toBe("Briefing for the remote region.");
    expect(Object.keys(remoteFor(cutFor(LINUX, "linux"))).sort()).toEqual(
      ["height", "hold", "id", "kind", "label", "width", "x", "y", "z"],
    );
    expect(cutFor(LINUX, "linux").regions.find((held) => held.id === "private")!.instruction).toBe(
      "Briefing nobody on the mini should read.",
    );
  });

  it("no longer refuses a page whose row names no machine: the page host is not read", () => {
    const unnamedPage = {
      ...everything,
      nodes: everything.nodes.map((node) => (node.id === "browser" ? ({ ...node, host: "local" } as Node) : node)),
    };
    expect(exportCanvasCopy(unnamedPage, { installationId: MINI, machineName: "mini" }).ok).toBe(true);
  });
});
