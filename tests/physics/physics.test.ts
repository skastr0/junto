import { describe, expect, it } from "vitest";
import { Result, HashMap, HashSet, Match, Option } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { WELL_KNOWN_ENTITY_KINDS } from "../../src/shared/canvas";
import { KIND_TO_SLOT } from "../../src/shared/managed-terminal-injection";
import {
  ALL_PORTS,
  GrantLaw,
  KindSpecs,
  PortForWorkOp,
  PortGrant,
  RuntimePlacement,
  TARGET_WORK_OPS,
  WELL_KNOWN_KINDS,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  canonicalRolePair,
  grantLawBetween,
  grantLawForRoles,
  kindsWithRole,
  nullPlacementView,
  portSet,
  resolveNodePlacement,
  resolveSpec,
  roleMayBeBlocked,
  roleOf,
  routeAllowed,
  seatMayBeBlocked,
  selectGrant,
  pairIsAssignable,
  undirectedEdgeKey,
  type NodePlacement,
  type Port,
  type Verb,
  type WellKnownKind,
} from "../../src/shared/physics";

const textNode = (
  id: string,
  kind: string | undefined,
  x = 0,
  y = 0,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x,
  y,
  width: 120,
  height: 48,
  ...(kind !== undefined
    ? { ether: { entity: { kind } } }
    : {}),
});

const pageNode = (id: string, x = 200, y = 0): CanvasDoc["nodes"][number] => ({
  id,
  type: "link",
  url: "https://example.com/",
  x,
  y,
  width: 120,
  height: 48,
  ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
});

/** Stamp ether.host without clobbering entity/browser. */
const withHost = (
  node: CanvasDoc["nodes"][number],
  host: string,
): CanvasDoc["nodes"][number] => ({
  ...node,
  ether: { ...(node.ether ?? {}), host },
});

const groupNode = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "group",
  label: id,
  x,
  y,
  width,
  height,
  ether: { region: { hold: true } },
});

describe("physics KindSpecs", () => {
  it("is exhaustive over WellKnownKind", () => {
    for (const kind of WELL_KNOWN_KINDS) {
      expect(KindSpecs[kind].kind).toBe(kind);
    }
    const keys = Object.keys(KindSpecs).sort();
    expect(keys).toEqual([...WELL_KNOWN_KINDS].sort());
  });

  it("maps every well-known kind to a role via the registry (not ad-hoc lists)", () => {
    for (const kind of WELL_KNOWN_KINDS) {
      expect(roleOf(resolveSpec({ isGroup: false, kind }))).toBe(KindSpecs[kind].role);
    }
    expect(roleOf(resolveSpec({ isGroup: true, kind: undefined }))).toBe("geography");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "note" }))).toBe("geography");
    expect(roleOf(resolveSpec({ isGroup: false, kind: undefined }))).toBe("geography");
  });

  it("kindsWithRole partitions WellKnownKind by KindSpecs.role", () => {
    const allRoles = ["actor", "sink", "scheduler", "geography"] as const;
    const seen = new Set<WellKnownKind>();
    for (const role of allRoles) {
      if (role === "geography") {
        expect(kindsWithRole(role)).toEqual([]);
        continue;
      }
      for (const kind of kindsWithRole(role)) {
        expect(KindSpecs[kind].role).toBe(role);
        seen.add(kind);
      }
    }
    expect([...seen].sort()).toEqual([...WELL_KNOWN_KINDS].sort());
  });
});

describe("physics phase membership", () => {
  it("only actor may be blocked; every other FactoryRole is refused", () => {
    expect(roleMayBeBlocked("actor")).toBe(true);
    expect(roleMayBeBlocked("sink")).toBe(false);
    expect(roleMayBeBlocked("scheduler")).toBe(false);
    expect(roleMayBeBlocked("geography")).toBe(false);
  });

  it("every registry kind agrees: actors blockable, non-actors not", () => {
    for (const kind of WELL_KNOWN_KINDS) {
      const role = KindSpecs[kind].role;
      const may = seatMayBeBlocked({ isGroup: false, kind });
      expect(may).toBe(role === "actor");
      expect(may).toBe(roleMayBeBlocked(role));
    }
    expect(seatMayBeBlocked({ isGroup: true, kind: undefined })).toBe(false);
    expect(seatMayBeBlocked({ isGroup: false, kind: undefined })).toBe(false);
  });

  it("geography offers empty", () => {
    const unknownKind = resolveSpec({ isGroup: false, kind: "label" });
    expect(roleOf(unknownKind)).toBe("geography");
    expect(HashSet.size(unknownKind.offers)).toBe(0);

    const group = resolveSpec({ isGroup: true, kind: undefined });
    expect(roleOf(group)).toBe("geography");
    expect(HashSet.size(group.offers)).toBe(0);
  });

  it("canvas WELL_KNOWN_ENTITY_KINDS includes watcher and timer", () => {
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("watcher");
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("timer");
  });

  it("canvas WELL_KNOWN_ENTITY_KINDS includes pad", () => {
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("pad");
  });
});

describe("physics GrantLaw (actor↔actor mailbox defaults)", () => {
  it("ActorSink and ActorActor are Full; ActorScheduler OptIn for relay.trigger", () => {
    expect(grantLawBetween(canonicalRolePair("actor", "sink"))._tag).toBe("Full");
    expect(grantLawBetween(canonicalRolePair("actor", "actor"))._tag).toBe("Full");
    expect(grantLawForRoles("actor", "scheduler")._tag).toBe("OptIn");
    expect(grantLawForRoles("actor", "geography")._tag).toBe("None");
    expect(grantLawForRoles("sink", "actor")._tag).toBe("None");
    expect(grantLawForRoles("geography", "sink")._tag).toBe("None");
  });

  it("selectGrant: Full attenuates by mask; OptIn remains explicit; None is empty", () => {
    const mask = portSet("msg.send");
    expect(selectGrant(GrantLaw.Full(), undefined).isFull()).toBe(true);
    expect(HashSet.has(selectGrant(GrantLaw.Full(), mask).ports, "msg.send")).toBe(true);
    expect(selectGrant(GrantLaw.OptIn(), undefined).isEmpty()).toBe(true);
    expect(HashSet.has(selectGrant(GrantLaw.OptIn(), mask).ports, "msg.send")).toBe(true);
    expect(HashSet.has(selectGrant(GrantLaw.OptIn(), mask).ports, "msg.list")).toBe(false);
    expect(selectGrant(GrantLaw.None(), mask).isEmpty()).toBe(true);
  });

  it("Match.tagsExhaustive is exhaustive over GrantLaw tags", () => {
    // Compile-time: adding a GrantLaw arm without updating this Match fails typecheck.
    // Runtime: every current tag is reachable.
    const tags = (["Full", "OptIn", "None"] as const).map((tag) => {
      const law =
        tag === "Full"
          ? GrantLaw.Full()
          : tag === "OptIn"
            ? GrantLaw.OptIn()
            : GrantLaw.None();
      return Match.value(law).pipe(
        Match.tagsExhaustive({
          Full: () => "Full",
          OptIn: () => "OptIn",
          None: () => "None",
        }),
      );
    });
    expect(tags).toEqual(["Full", "OptIn", "None"]);
  });

  it("no-mask materialization of laws", () => {
    expect(selectGrant(grantLawBetween(canonicalRolePair("actor", "sink")), undefined).isFull()).toBe(true);
    // Actor↔actor now uses the unmasked Full default.
    expect(selectGrant(grantLawBetween(canonicalRolePair("actor", "actor")), undefined).isFull()).toBe(true);
    expect(selectGrant(grantLawForRoles("actor", "sink"), undefined).isFull()).toBe(true);
    expect(selectGrant(grantLawForRoles("actor", "geography"), undefined).isEmpty()).toBe(true);
  });
});

describe("physics PortGrant attenuation", () => {
  it("never expands", () => {
    const full = PortGrant.full;
    const mask = portSet("msg.send", "browser.automate");
    const attenuated = full.attenuate(mask);
    expect(attenuated.isFull()).toBe(false);
    expect(HashSet.has(attenuated.ports, "msg.send")).toBe(true);
    expect(HashSet.has(attenuated.ports, "browser.automate")).toBe(true);
    expect(HashSet.has(attenuated.ports, "msg.list")).toBe(false);

    const empty = PortGrant.empty.attenuate(mask);
    expect(empty.isEmpty()).toBe(true);
    expect(HashSet.size(empty.ports)).toBe(0);

    const subset = PortGrant.of("msg.send", "msg.list");
    const shrunk = subset.attenuate(portSet("msg.send", "browser.automate"));
    expect(HashSet.has(shrunk.ports, "msg.send")).toBe(true);
    expect(HashSet.has(shrunk.ports, "msg.list")).toBe(false);
    expect(HashSet.has(shrunk.ports, "browser.automate")).toBe(false);

    // Re-attenuating with a larger mask still cannot reintroduce msg.list
    const again = shrunk.attenuate(portSet("msg.send", "msg.list", "browser.automate"));
    expect(HashSet.has(again.ports, "msg.list")).toBe(false);
  });

  it("allows checks offers under full and subset", () => {
    const offers = portSet("browser.automate", "msg.send");
    expect(PortGrant.full.allows("browser.automate", offers)).toBe(true);
    expect(PortGrant.full.allows("tasks.list", offers)).toBe(false);
    expect(PortGrant.of("msg.send").allows("msg.send", offers)).toBe(true);
    expect(PortGrant.of("msg.send").allows("browser.automate", offers)).toBe(false);
    expect(PortGrant.empty.allows("msg.send", offers)).toBe(false);
  });
});

describe("physics work-ports", () => {
  it("covers every target WorkOpName", () => {
    for (const op of TARGET_WORK_OPS) {
      expect(PortForWorkOp[op]).toBeDefined();
    }
    expect(Object.keys(PortForWorkOp).sort()).toEqual([...TARGET_WORK_OPS].sort());
    expect(PortForWorkOp["request.escalate"]).toBe("request.escalate");
  });
});

describe("physics admitPure", () => {
  it("admits actor → page browser.automate when edge-connected", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [
        { id: "e1", fromNode: "agent", toNode: "p1", ether: { verb: "navigates" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.port).toBe("browser.automate");
      expect(result.success.caller).toBe("agent");
      expect(result.success.target).toBe("p1");
    }
  });

  it("admits an agent seat — the one actor kind — for browser.automate", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("seat", "agent"), pageNode("p1")],
      edges: [
        { id: "e1", fromNode: "seat", toNode: "p1", ether: { verb: "navigates" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("seat"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("denies browser.automate to geography — a raw shell is not an actor", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("seat", "terminal"), pageNode("p1")],
      edges: [{ id: "e1", fromNode: "seat", toNode: "p1" }],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("seat"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isFailure(result)).toBe(true);
  });

  it("denies with not_connected when only region co-members (no edge)", () => {
    const doc: CanvasDoc = {
      nodes: [
        groupNode("g1", 0, 0, 400, 200),
        textNode("agent", "agent", 40, 40),
        pageNode("p1", 200, 40),
      ],
      edges: [],
    };
    const view = canvasDocToCapabilityView(doc);
    // Both centers are inside the group → region peers.
    const peers = HashMap.get(view.regionPeers, asNodeId("agent"));
    expect(Option.isSome(peers)).toBe(true);
    if (Option.isSome(peers)) {
      expect(HashSet.has(peers.value, asNodeId("p1"))).toBe(true);
    }

    const result = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("not_connected");
    }
  });

  it("denies with invisible when no edge and not region peers", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1", 2000, 2000)],
      edges: [],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("invisible");
    }
  });

  it("denies unknown_node", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent")],
      edges: [],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("missing"),
      "msg.send",
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("unknown_node");
    }
  });

  it("denies no_port when target does not offer the port", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), textNode("task1", "task", 200, 0)],
      edges: [{ id: "e1", fromNode: "agent", toNode: "task1" }],
    };
    const view = canvasDocToCapabilityView(doc);
    // tasks offer task ports, not browser
    const result = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("task1"),
      "browser.automate",
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("no_port");
    }
  });

  it("admits task work ports on connected agent→task edge", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), textNode("task1", "task", 200, 0)],
      edges: [
        { id: "e1", fromNode: "agent", toNode: "task1", ether: { verb: "contributes" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    for (const port of [
      "tasks.list",
      "tasks.claim",
      "tasks.update",
      "msg.list",
      "msg.send",
    ] as const satisfies ReadonlyArray<Port>) {
      const result = admitPure(view, asNodeId("agent"), asNodeId("task1"), port);
      expect(Result.isSuccess(result), port).toBe(true);
    }
  });

  it("denies role_law for geography target with empty offers law", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), textNode("note", undefined, 200, 0)],
      edges: [{ id: "e1", fromNode: "agent", toNode: "note" }],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("note"),
      "msg.send",
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("role_law");
    }
  });

  it("a verb that never opens the port denies with no_port", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), textNode("pad1", "pad", 200, 0)],
      edges: [
        // Reading a pad is the narrow half of the pair; patching is the wide one.
        { id: "e1", fromNode: "agent", toNode: "pad1", ether: { verb: "reads" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    expect(
      Result.isSuccess(admitPure(view, asNodeId("agent"), asNodeId("pad1"), "pad.read")),
    ).toBe(true);
    const denied = admitPure(view, asNodeId("agent"), asNodeId("pad1"), "pad.patch");
    expect(Result.isFailure(denied)).toBe(true);
    if (Result.isFailure(denied)) {
      expect(denied.failure.reason).toBe("no_port");
    }
  });

  it("an edge with no verb grants nothing", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [{ id: "e1", fromNode: "agent", toNode: "p1" }],
    };
    const view = canvasDocToCapabilityView(doc);
    // Connectivity is still there; the relationship just says nothing.
    expect(HashMap.size(view.edgePortMask)).toBe(1);
    const denied = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isFailure(denied)).toBe(true);
    if (Result.isFailure(denied)) {
      expect(denied.failure.reason).toBe("no_port");
    }
  });

  it("a verb the pair cannot hold grants nothing", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      // Hand-edited or stale: `edits` belongs to pad, never to a page.
      edges: [{ id: "e1", fromNode: "agent", toNode: "p1", ether: { verb: "edits" } }],
    };
    const view = canvasDocToCapabilityView(doc);
    const denied = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isFailure(denied)).toBe(true);
  });


  it("actor mail: the messages verb opens both mailbox ports", () => {
    const doc: CanvasDoc = {
      nodes: [
        textNode("a1", "agent"),
        textNode("a2", "agent", 200, 0),
      ],
      edges: [
        { id: "e1", fromNode: "a1", toNode: "a2", ether: { verb: "messages" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    // Discovery: undirected connectivity present
    const neighbors = HashMap.get(view.connected, asNodeId("a1"));
    expect(Option.isSome(neighbors)).toBe(true);
    if (Option.isSome(neighbors)) {
      expect(HashSet.has(neighbors.value, asNodeId("a2"))).toBe(true);
    }
    // Symmetric: the one verb an agent pair holds reads the same both ways.
    for (const port of ["msg.send", "msg.list"] as const) {
      expect(
        Result.isSuccess(admitPure(view, asNodeId("a1"), asNodeId("a2"), port)),
        port,
      ).toBe(true);
      expect(
        Result.isSuccess(admitPure(view, asNodeId("a2"), asNodeId("a1"), port)),
        port,
      ).toBe(true);
    }
  });


});

describe("physics grant union (I7 — parallel edges combine as union)", () => {
  const verbEdge = (
    id: string,
    fromNode: string,
    toNode: string,
    verb: Verb,
  ): CanvasDoc["edges"][number] => ({ id, fromNode, toNode, ether: { verb } });

  const taskDoc = (edges: CanvasDoc["edges"]): CanvasDoc => ({
    nodes: [textNode("agent", "agent"), textNode("task1", "task", 200, 0)],
    edges,
  });

  const admittedPorts = (view: ReturnType<typeof canvasDocToCapabilityView>) =>
    (
      [
        "tasks.list",
        "tasks.create",
        "tasks.claim",
        "tasks.update",
        "msg.list",
        "msg.send",
      ] as const satisfies ReadonlyArray<Port>
    ).filter((port) =>
      Result.isSuccess(admitPure(view, asNodeId("agent"), asNodeId("task1"), port)),
    );

  const ALL_TASK_PORTS = [
    "msg.list",
    "msg.send",
    "tasks.claim",
    "tasks.create",
    "tasks.list",
    "tasks.update",
  ].sort();

  const MANAGE_ONLY = [
    "msg.list",
    "msg.send",
    "tasks.create",
    "tasks.list",
    "tasks.update",
  ].sort();

  it("one verb: the pair admits exactly what that verb compiles", () => {
    const view = canvasDocToCapabilityView(
      taskDoc([verbEdge("e1", "agent", "task1", "manages")]),
    );
    // Managing a queue never pulls from it — no tasks.claim.
    expect(admittedPorts(view).sort()).toEqual(MANAGE_ONLY);
  });

  it("two verbs on one pair union their grants", () => {
    const view = canvasDocToCapabilityView(
      taskDoc([
        verbEdge("e1", "agent", "task1", "manages"),
        verbEdge("e2", "task1", "agent", "works"),
      ]),
    );
    expect(admittedPorts(view).sort()).toEqual(ALL_TASK_PORTS);
  });

  it("union dedupes the ports both verbs open", () => {
    const view = canvasDocToCapabilityView(
      taskDoc([
        verbEdge("e1", "agent", "task1", "contributes"),
        verbEdge("e2", "task1", "agent", "works"),
      ]),
    );
    const mask = HashMap.get(view.edgePortMask, undirectedEdgeKey("agent", "task1"));
    expect(Option.isSome(mask)).toBe(true);
    if (Option.isSome(mask)) {
      expect(Array.from(mask.value).sort()).toEqual(ALL_TASK_PORTS);
    }
  });

  it("a verbless edge beside a verbed one adds nothing and takes nothing", () => {
    const view = canvasDocToCapabilityView(
      taskDoc([
        verbEdge("e1", "agent", "task1", "manages"),
        { id: "e2", fromNode: "task1", toNode: "agent" },
      ]),
    );
    expect(admittedPorts(view).sort()).toEqual(MANAGE_ONLY);
  });

  it("only works marks the pair assignable, whichever edge carries it", () => {
    const contributed = canvasDocToCapabilityView(
      taskDoc([verbEdge("e1", "agent", "task1", "contributes")]),
    );
    expect(pairIsAssignable(contributed, "agent", "task1")).toBe(false);
    const worked = canvasDocToCapabilityView(
      taskDoc([
        verbEdge("e1", "agent", "task1", "manages"),
        verbEdge("e2", "task1", "agent", "works"),
      ]),
    );
    expect(pairIsAssignable(worked, "agent", "task1")).toBe(true);
  });
});

describe("physics KindSpecs offers match behavior-preserving work surface", () => {
  it("page offers only browser.automate", () => {
    expect(Array.from(KindSpecs.page.offers).sort()).toEqual([
      "browser.automate",
    ]);
  });

  it("pad offers only pad.read and pad.patch", () => {
    expect(Array.from(KindSpecs.pad.offers).sort()).toEqual([
      "pad.patch",
      "pad.read",
    ]);
  });

  it("every well-known kind has a concrete role", () => {
    const roles = new Set(
      (Object.keys(KindSpecs) as WellKnownKind[]).map((k) => KindSpecs[k].role),
    );
    expect(roles.has("actor")).toBe(true);
    expect(roles.has("sink")).toBe(true);
    expect(roles.has("scheduler")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S11 — placement plane (I18/I19)

describe("physics placement resolve + null producer", () => {
  it("null PlacementView returns undefined for every node (fail-closed input)", () => {
    expect(nullPlacementView.placementFor("any")).toBeUndefined();
  });

  it("default topology: local host → command center", () => {
    const node = textNode("a1", "agent");
    const p = resolveNodePlacement(node);
    expect(p.runtime._tag).toBe("Cc");
    expect(p.assignment).toBe("local");
  });

  it("non-local host → station, carrying its host id", () => {
    const node = withHost(textNode("a1", "agent"), "station-b");
    const p = resolveNodePlacement(node);
    expect(p.runtime._tag).toBe("Station");
    if (p.runtime._tag === "Station") expect(p.runtime.hostId).toBe("station-b");
  });

  it("routeAllowed: same station ok; Station↔Station denied; CC↔Station ok", () => {
    const sta = (hostId: string): NodePlacement => ({
      runtime: RuntimePlacement.Station({ hostId }),
      assignment: hostId,
    });
    const cc: NodePlacement = {
      runtime: RuntimePlacement.Cc(),
      assignment: "local",
    };
    expect(routeAllowed(sta("a"), sta("a"))).toBe(true);
    expect(routeAllowed(sta("a"), sta("b"))).toBe(false);
    expect(routeAllowed(cc, sta("b"))).toBe(true);
    expect(routeAllowed(sta("b"), cc)).toBe(true);
  });
});

describe("physics placement admit (I18/I19)", () => {
  const place = (
    runtime: NodePlacement["runtime"],
    assignment?: string,
  ): NodePlacement => ({
    runtime,
    ...(assignment !== undefined ? { assignment } : {}),
  });

  it("station-A actor → station-B page: route denial (not no_port)", () => {
    const doc: CanvasDoc = {
      nodes: [
        withHost(textNode("agent-a", "agent"), "station-a"),
        withHost(pageNode("page-b"), "station-b"),
      ],
      edges: [{ id: "e1", fromNode: "agent-a", toNode: "page-b" }],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("agent-a"),
      asNodeId("page-b"),
      "browser.automate",
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("route");
      expect(result.failure.reason).not.toBe("no_port");
      expect(result.failure.message).toMatch(/Command Center route/i);
    }
  });

  it("CC actor → station page: route allowed (admit on port)", () => {
    const doc: CanvasDoc = {
      nodes: [
        withHost(textNode("cc-agent", "agent"), "local"),
        withHost(pageNode("page-b"), "station-b"),
      ],
      edges: [
        { id: "e1", fromNode: "cc-agent", toNode: "page-b", ether: { verb: "navigates" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("cc-agent"),
      asNodeId("page-b"),
      "browser.automate",
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("same-station actor → page: admits", () => {
    const doc: CanvasDoc = {
      nodes: [
        withHost(textNode("agent-a", "agent"), "station-a"),
        withHost(pageNode("page-a"), "station-a"),
      ],
      edges: [
        { id: "e1", fromNode: "agent-a", toNode: "page-a", ether: { verb: "navigates" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("agent-a"),
      asNodeId("page-a"),
      "browser.automate",
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("placement unknown (omitted map entry) fails closed", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("page1")],
      edges: [{ id: "e1", fromNode: "agent", toNode: "page1" }],
    };
    // Only caller placed — target missing → unknown
    let placement = HashMap.empty<ReturnType<typeof asNodeId>, NodePlacement>();
    placement = HashMap.set(
      placement,
      asNodeId("agent"),
      place(RuntimePlacement.Cc(), "local"),
    );
    const view = canvasDocToCapabilityView(doc, { placement });
    const result = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("page1"),
      "browser.automate",
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("placement_unknown");
      expect(result.failure.message).toMatch(/fail closed/i);
    }
  });

});

// ---------------------------------------------------------------------------
// A task pipeline hop is plumbing between sinks, never a capability.

describe("a task pipeline hop grants nothing", () => {
  // seat —contributes— intake —feeds— review. The hop must add no port
  // anywhere, and must not extend the seat's reach past its own sink.
  const doc: CanvasDoc = {
    nodes: [
      textNode("seat", "agent", 0),
      textNode("intake", "task", 200),
      textNode("review", "task", 400),
    ],
    edges: [
      { id: "access", fromNode: "seat", toNode: "intake", ether: { verb: "contributes" } },
      { id: "hop", fromNode: "intake", toNode: "review", ether: { verb: "feeds" } },
    ],
  };

  const held = (caller: string, target: string): ReadonlyArray<string> => {
    const view = canvasDocToCapabilityView(doc);
    return ALL_PORTS.filter((port) =>
      Result.isSuccess(admitPure(view, asNodeId(caller), asNodeId(target), port)),
    );
  };

  it("still grants the seat its own sink (the contrast case)", () => {
    expect(held("seat", "intake")).toEqual([
      "tasks.list",
      "tasks.create",
      "tasks.claim",
      "tasks.update",
      "msg.list",
      "msg.send",
    ]);
  });

  it("gives the seat no reach past the hop", () => {
    expect(held("seat", "review")).toEqual([]);
  });

  it("gives the hop's own endpoints nothing in either direction", () => {
    expect(held("intake", "review")).toEqual([]);
    expect(held("review", "intake")).toEqual([]);
  });

  it("leaves the injection slot tables untouched — a hop is not a capability", () => {
    // Slots are keyed by kind, so a hop cannot mint one; task stays "tasks".
    expect(KIND_TO_SLOT["task"]).toBe("tasks");
    expect(Object.keys(KIND_TO_SLOT)).not.toContain("feeds");
  });
});
