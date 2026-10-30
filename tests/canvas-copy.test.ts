import { ItemId } from "../src/shared/work-ids";
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
import { mergeRegionEnvironment, planRegionEnvironment } from "../src/shared/region-environment";
import { asCanvasName, asNodeId, type Node, type Region, type Wire } from "../src/shared/model";
import { files, page, seat as seatNode, wire } from "./support/model-nodes";

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
  automations: [],
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
  const result = exportCanvasCopy(source, { installationId: MINI, machineName: "mini" }, "cut");
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

  it("goes to a machine with an automation and no seat, and says where every automation runs", () => {
    const automations = [
      { automationId: ItemId.make("01M629AAAAAAAAAAAAAAAAAAAA"), nodeId: asNodeId("routines"), machine: "stranger" as never },
      { automationId: ItemId.make("01M629BBBBBBBBBBBBBBBBBBBB"), nodeId: asNodeId("routines"), machine: "mini" as never },
    ];
    const cut = exportCanvasCopy({ ...source, automations }, { installationId: id("stranger"), machineName: "stranger" }, "cut");
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.copy.seats).toEqual([]);
    expect(cut.copy.automations).toEqual(automations);
  });

  it("is refused for the editing machine, for a machine with no seat, and while a row names no machine", () => {
    expect(exportCanvasCopy(source, { installationId: EDITOR, machineName: "macbook" }, "cut")).toEqual({
      ok: false,
      refusal: { reason: "the-editing-machine-holds-the-canvas" },
    });
    expect(exportCanvasCopy(source, { installationId: id("stranger"), machineName: "stranger" }, "cut")).toEqual({
      ok: false,
      refusal: { reason: "no-seat-or-automation-on-that-machine" },
    });
    const unnamed = { ...source, nodes: [...nodes, seat("stray", "local", { x: 50, y: 300 })] };
    expect(exportCanvasCopy(unnamed, { installationId: MINI, machineName: "mini" }, "cut")).toEqual({
      ok: false,
      refusal: { reason: "a-row-names-no-machine", nodeId: "stray" },
    });
    const unnamedFolder = {
      ...source,
      nodes: nodes.map((node) => (node.id === "private" ? { ...node, defaults: { paths: { local: "/tmp" } } } as Node : node)),
    };
    expect(exportCanvasCopy(unnamedFolder, { installationId: MINI, machineName: "mini" }, "cut")).toMatchObject({
      ok: false,
      refusal: { reason: "a-row-names-no-machine", nodeId: "private" },
    });
    const unnamedFiles = { ...source, nodes: [...nodes, files("stray-folder", { host: "local" as never })] };
    expect(exportCanvasCopy(unnamedFiles, { installationId: MINI, machineName: "mini" }, "cut")).toEqual({
      ok: false,
      refusal: { reason: "a-row-names-no-machine", nodeId: "stray-folder" },
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
    { kind: "task", id: asNodeId("review"), ...inRemote(610), name: "Review" },
    { kind: "artifacts", id: asNodeId("shelf"), ...inRemote(60), label: "Shelf" },
    { kind: "label", id: asNodeId("caption"), ...inRemote(110), text: "Caption" },
    { kind: "file", id: asNodeId("spec"), ...inRemote(160), path: "/Users/op/private-dir/spec.md" },
    { kind: "link", id: asNodeId("docs"), ...inRemote(210), url: "https://docs.test/secret-path?token=1" },
    { kind: "file", id: asNodeId("named-spec"), ...inRemote(710), path: "/Users/op/private-dir/plan.md", label: "Launch plan" },
    { kind: "link", id: asNodeId("named-docs"), ...inRemote(760), url: "https://docs.test/secret-path", label: "Team handbook" },
    page("named-browser", { ...inRemote(810), url: "https://browser.test/secret-page", profile: "work-profile", label: "Page name stays home" }),
    { kind: "git", id: asNodeId("repo"), ...inRemote(260), cwd: "/Users/op/private-repo" },
    { kind: "git", id: asNodeId("named-repo"), ...inRemote(560), cwd: "/Users/op/other-repo", label: "Junto source" },
    // The shared builder, so the page keeps compiling when its host field goes (R4).
    page("browser", { ...inRemote(310), url: "https://browser.test/secret-page", profile: "work-profile" }),
    { kind: "note", id: asNodeId("memo"), ...inRemote(360), text: "Note body stays home." },
    { kind: "automations", id: asNodeId("routines"), ...inRemote(660), label: "Morning routines" },
    files("folder", { ...inRemote(860), host: "macbook" as never, root: "/Users/op/files-root", label: "Shared drafts" }),
    files("bare-folder", { ...inRemote(910), host: "macbook" as never, root: "/Users/op/bare-files-root" }),
  ];
  const lin = seat("lin", "linux", { x: 2300, y: 50 });
  const everything: CanvasCopySource = {
    ...source,
    nodes: [...nodes, lin, ...resources],
    wires: [
      ...wires,
      // Resource nodes carry no wire but task to task (01); the cut reads no verb.
      wire("backlog-to-review", "backlog", "review", "messages"),
      wire("lead-to-browser", "lead", "browser", "messages"),
      wire("lead-to-memo", "lead", "memo", "messages"),
      wire("lead-to-spec", "lead", "spec", "messages"),
      wire("lead-to-docs", "lead", "docs", "messages"),
      wire("lead-to-repo", "lead", "repo", "messages"),
    ],
    seatIdOf: (node) => seatId(node.id === "lead" ? "1" : node.id === "peer" ? "2" : node.id === "solo" ? "3" : "4"),
  };
  const cutFor = (installationId: typeof MINI, machineName: string): CanvasCopy => {
    const result = exportCanvasCopy(everything, { installationId, machineName }, "cut");
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
    ["task", "review", { kind: "task", id: "review", ...at(610), name: "Review" }],
    ["artifacts", "shelf", { kind: "artifacts", id: "shelf", ...at(60), label: "Shelf" }],
    ["label", "caption", { kind: "label", id: "caption", ...at(110), text: "Caption" }],
    // A stub is named only by what the operator wrote, never by its path or address.
    ["file", "spec", { kind: "stub", of: "file", id: "spec", ...at(160) }],
    ["link", "docs", { kind: "stub", of: "link", id: "docs", ...at(210) }],
    ["file", "named-spec", { kind: "stub", of: "file", id: "named-spec", ...at(710), label: "Launch plan" }],
    ["link", "named-docs", { kind: "stub", of: "link", id: "named-docs", ...at(760), label: "Team handbook" }],
    ["git", "repo", { kind: "stub", of: "git", id: "repo", ...at(260) }],
    ["git", "named-repo", { kind: "stub", of: "git", id: "named-repo", ...at(560), label: "Junto source" }],
    // The editing machine's name: pages live where the canvas is edited.
    ["page", "browser", { kind: "stub", of: "page", id: "browser", ...at(310), host: "macbook" }],
    // A page's name stays home: a page stub names only its machine.
    ["page", "named-browser", { kind: "stub", of: "page", id: "named-browser", ...at(810), host: "macbook" }],
    ["note", "memo", undefined],
    // Every machine places the automations on it (0.11/05 S2); what they do rides rulings, never the copy.
    ["automations", "routines", { kind: "automations", id: "routines", ...at(660), label: "Morning routines" }],
    // A files node crosses as a stub: its label when the operator wrote one, never its host or root.
    ["files", "folder", { kind: "stub", of: "files", id: "folder", ...at(860), label: "Shared drafts" }],
    ["files", "bare-folder", { kind: "stub", of: "files", id: "bare-folder", ...at(910) }],
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
          "spec.md",
          "docs.test",
          "secret-path",
          "private-repo",
          "other-repo",
          "browser.test",
          "secret-page",
          "work-profile",
          "Note body stays home",
          "Page name stays home",
          "plan.md",
          "files-root",
          "0 3 * * *",
        ]) {
          expect(sent).not.toContain(never);
        }
      });

      it("keeps a task-to-task wire, no other wire to a resource, and none to a stub or a note", () => {
        const copy = destination.copy();
        const held = copy.wires.map((kept) => kept.id);
        // Tasks may be switched off in this build; then no task crosses, and no wire to one.
        if (productNodeKindEnabled("task")) expect(held).toContain("backlog-to-review");
        else expect(held).not.toContain("backlog-to-review");
        const kindOf = new Map(copy.resources.map((resource) => [resource.id as string, resource.kind]));
        for (const kept of copy.wires) {
          const ends = [kindOf.get(kept.from), kindOf.get(kept.to)];
          if (ends.some((kind) => kind === "task" || kind === "artifacts")) expect(ends).toEqual(["task", "task"]);
        }
        for (const dropped of ["lead-to-browser", "lead-to-spec", "lead-to-docs", "lead-to-repo", "lead-to-memo"]) {
          expect(held).not.toContain(dropped);
        }
      });

      it("decodes as written", () => {
        expect(Result.isSuccess(decodeCanvasCopy(JSON.parse(JSON.stringify(destination.copy()))))).toBe(true);
      });
    });
  }

  it("names a file, a link, an unlabelled repository or files node by nothing: no path, folder or address leaks through a default", () => {
    for (const nodeId of ["spec", "docs", "repo", ...(productNodeKindEnabled("files") ? ["bare-folder"] : [])]) {
      const stub = cutFor(MINI, "mini").resources.find((resource) => resource.id === nodeId)!;
      expect(stub.kind).toBe("stub");
      expect("label" in stub).toBe(false);
    }
  });

  it("carries a files stub with no host or path for another machine", () => {
    if (!productNodeKindEnabled("files")) return;
    const stub = cutFor(MINI, "mini").resources.find((resource) => resource.id === "folder")!;
    expect(Object.keys(stub).sort()).toEqual(["height", "id", "kind", "label", "of", "width", "x", "y", "z"]);
  });

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
    expect(exportCanvasCopy(unnamedPage, { installationId: MINI, machineName: "mini" }, "cut").ok).toBe(true);
  });
});

/**
 * A machine on the canvas's committed authority list is a keeper (0.11/06 F3):
 * its copy is the canvas the way the editing machine holds it — every seat,
 * terminal, region and note whole, every wire, every seat's guidance, every
 * reference — so it can take over and recut for anyone. What never crosses is
 * the same in both modes: no resolved secret value, no credential or session
 * pin, and no stub's path, address or host.
 */
describe("a canvas kept whole for a listed machine", () => {
  const KEEPER = id("keeper-installation");
  const keptFor = (installationId: InstallationId, machineName: string, over: Partial<CanvasCopySource> = {}): CanvasCopy => {
    const result = exportCanvasCopy({ ...source, ...over }, { installationId, machineName }, "keeper");
    if (!result.ok) throw new Error(result.refusal.reason);
    return result.copy;
  };
  const kept = (over: Partial<CanvasCopySource> = {}): CanvasCopy => keptFor(KEEPER, "keeper", over);

  it("is owed to a listed machine with no seat or automation on it, and decodes as written", () => {
    const copy = kept();
    expect(copy).toMatchObject({ canvasName: "factory", canvasId: "canvas-factory", seq: 41, editor: EDITOR, target: KEEPER, playing: true });
    expect(Result.isSuccess(decodeCanvasCopy(JSON.parse(JSON.stringify(copy))))).toBe(true);
    // The same target, unlisted, is still refused.
    expect(exportCanvasCopy(source, { installationId: KEEPER, machineName: "keeper" }, "cut")).toEqual({
      ok: false,
      refusal: { reason: "no-seat-or-automation-on-that-machine" },
    });
  });

  it("holds every seat and terminal whole, and no seat as a peer", () => {
    const copy = kept();
    expect(copy.seats).toEqual(nodes.filter((node) => node.kind === "agent"));
    expect(copy.peers).toEqual([]);
    expect(copy.terminals).toEqual(nodes.filter((node) => node.kind === "terminal"));
    const sent = JSON.stringify(copy);
    for (const full of ["binding-lead", "binding-solo", "binding-macbook-shell", "macbook:claude"]) {
      expect(sent).toContain(full);
    }
  });

  it("holds every region whole: the private parts, every machine's paths, every environment source", () => {
    const copy = kept();
    expect(copy.regions).toEqual(nodes.filter((node) => node.kind === "region"));
    const sent = JSON.stringify(copy);
    for (const full of [
      "nobody on the mini",
      "never-sent",
      "/Users/op/junto",
      "EDITOR_ONLY",
      "sunset.png",
      "example.com",
      "token-1",
    ]) {
      expect(sent).toContain(full);
    }
  });

  it("carries a region secret and a vault reference, never a resolved value", () => {
    const copy = kept({
      nodes: nodes.map((node) =>
        node.id === "remote"
          ? ({
              ...node,
              environment: {
                vault: { backend: "onepassword", vault: "corp" },
                sources: [
                  { id: "s1", kind: "secret", name: "TOKEN", secretId: "token-1" },
                  { id: "s2", kind: "onepassword", name: "DB", ref: "op://corp/db/password" },
                  { id: "s3", kind: "envFile", path: "/Users/op/.env.junto" },
                  { id: "s4", kind: "command", name: "ISSUER", argv: ["junto-secret", "issuer"] },
                ],
              },
            } as Node)
          : node,
      ),
    });
    const remote = copy.regions.find((held) => held.id === "remote")!;
    // What crosses is the authored row, field for field: the references the
    // keeper resolves against its own stores, and nothing resolved.
    expect(remote.environment?.sources).toEqual([
      { id: "s1", kind: "secret", name: "TOKEN", secretId: "token-1" },
      { id: "s2", kind: "onepassword", name: "DB", ref: "op://corp/db/password" },
      { id: "s3", kind: "envFile", path: "/Users/op/.env.junto" },
      { id: "s4", kind: "command", name: "ISSUER", argv: ["junto-secret", "issuer"] },
    ]);
  });

  it("holds every note, every wire, every seat's guidance and every reference", () => {
    const copy = kept();
    expect(copy.notes).toEqual(nodes.filter((node) => node.kind === "note"));
    expect(copy.wires).toEqual(wires);
    expect(copy.guidance).toEqual([
      { nodeId: "lead", soul: "The lead's soul.", instructions: "The lead's instructions." },
      { nodeId: "peer", soul: "The peer's soul." },
    ]);
    expect(copy.references.map((reference) => reference.name)).toEqual(["style", "runbook", "secrets-policy"]);
    expect(JSON.stringify(copy)).toContain("written by the operator");
  });

  it("is still refused for the editing machine", () => {
    expect(exportCanvasCopy(source, { installationId: EDITOR, machineName: "macbook" }, "keeper")).toEqual({
      ok: false,
      refusal: { reason: "the-editing-machine-holds-the-canvas" },
    });
  });

  it("plans a skipped host, never the value, for its own seat where a source names another machine", () => {
    const copy = keptFor(MINI, "mini");
    const doc = {
      name: asCanvasName("factory"),
      seq: copy.seq,
      nodes: new Map<Node["id"], Node>([
        ...copy.regions.map((region) => [region.id, region] as const),
        ...copy.seats.map((seat) => [seat.id, seat] as const),
      ]),
      wires: new Map(copy.wires.map((kept) => [kept.id, kept])),
    };
    // The keeper's own seat resolves for this machine: a source that names the
    // macbook stays restricted to it even though its row now sits here whole.
    const plan = planRegionEnvironment(doc, { seat: "peer" }, "mini");
    expect(plan.sources.find((planned) => planned.source.id === "macbook-only")?.skippedHost).toBe(true);
    const outcomes = new Map(
      plan.sources
        .filter((planned) => !planned.skippedHost)
        .map((planned, index) => [planned.key, { status: "ok" as const, values: { [`RESOLVED_${index}`]: "here" } }]),
    );
    const merged = mergeRegionEnvironment(plan, outcomes);
    expect(merged.report.find((entry) => entry.sourceId === "macbook-only")?.status).toBe("skipped-host");
    // Other sources resolved into the env; the restricted one contributed nothing.
    expect(Object.values(merged.env)).toContain("here");
    expect("EDITOR_ONLY" in merged.env).toBe(false);
    expect(Object.values(merged.env)).not.toContain("x");
  });
});
