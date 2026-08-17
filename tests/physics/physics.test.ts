import { describe, expect, it } from "vitest";
import { Result, HashMap, HashSet, Match, Option } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { WELL_KNOWN_ENTITY_KINDS } from "../../src/shared/canvas";
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
  undirectedEdgeKey,
  type NodePlacement,
  type Port,
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
      edges: [{ id: "e1", fromNode: "agent", toNode: "p1" }],
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
      edges: [{ id: "e1", fromNode: "seat", toNode: "p1" }],
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

  it("denies browser.automate to geography — a herdr pane is not an actor", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("seat", "herdr"), pageNode("p1")],
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
      edges: [{ id: "e1", fromNode: "agent", toNode: "task1" }],
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

  it("attenuates via edge port mask when present (drops browser.automate)", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [
        {
          id: "e1",
          fromNode: "agent",
          toNode: "p1",
          // Mask is only msg.send — not browser.automate (read-only-style attenuation).
          ether: { ports: ["msg.send"] },
        },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
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

  it("absent ports = full offers (browser.automate still admitted)", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [{ id: "e1", fromNode: "agent", toNode: "p1" }],
    };
    const view = canvasDocToCapabilityView(doc);
    expect(HashMap.size(view.edgePortMask)).toBe(0);
    const admitted = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isSuccess(admitted)).toBe(true);
  });

  it("invalid-only port strings yield empty mask (nothing allowed)", () => {
    const doc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [
        {
          id: "e1",
          fromNode: "agent",
          toNode: "p1",
          // Not a Port literal — skipped; explicit ports:[] shape remains.
          ether: { ports: ["browser.read"] },
        },
      ],
    } as unknown as CanvasDoc;
    const view = canvasDocToCapabilityView(doc);
    // Explicit mask present but empty after invalid tokens dropped.
    expect(HashMap.size(view.edgePortMask)).toBe(1);
    const admitted = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isSuccess(admitted)).toBe(false);
  });

  it("fresh actor↔actor, no ports → both mailbox ports are admitted by default", () => {
    const doc: CanvasDoc = {
      nodes: [
        textNode("a1", "agent"),
        textNode("a2", "agent", 200, 0),
      ],
      edges: [{ id: "e1", fromNode: "a1", toNode: "a2" }],
    };
    const view = canvasDocToCapabilityView(doc);
    // Discovery: undirected connectivity present
    const neighbors = HashMap.get(view.connected, asNodeId("a1"));
    expect(Option.isSome(neighbors)).toBe(true);
    if (Option.isSome(neighbors)) {
      expect(HashSet.has(neighbors.value, asNodeId("a2"))).toBe(true);
    }
    for (const port of ["msg.send", "msg.list"] as const) {
      const admitted = admitPure(view, asNodeId("a1"), asNodeId("a2"), port);
      expect(Result.isSuccess(admitted), port).toBe(true);
    }
  });

  it("actor↔actor with ports:[msg.send] → msg.send admits, msg.list denies", () => {
    const doc: CanvasDoc = {
      nodes: [
        textNode("a1", "agent"),
        textNode("a2", "agent", 200, 0),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "a1",
          toNode: "a2",
          ether: { ports: ["msg.send"] },
        },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    const send = admitPure(view, asNodeId("a1"), asNodeId("a2"), "msg.send");
    expect(Result.isSuccess(send)).toBe(true);
    const list = admitPure(view, asNodeId("a1"), asNodeId("a2"), "msg.list");
    expect(Result.isFailure(list)).toBe(true);
    if (Result.isFailure(list)) {
      expect(list.failure.reason).toBe("no_port");
    }
  });

});

describe("physics mask union (I7 — multi-edge masks combine as union)", () => {
  const portsEdge = (
    id: string,
    fromNode: string,
    toNode: string,
    ports?: ReadonlyArray<Port>,
  ): CanvasDoc["edges"][number] => ({
    id,
    fromNode,
    toNode,
    ...(ports !== undefined ? { ether: { ports } } : {}),
  });

  const taskDoc = (
    edges: CanvasDoc["edges"],
  ): CanvasDoc => ({
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

  it("no-mask: neither edge declares ports ⇒ full offers", () => {
    const doc = taskDoc([
      portsEdge("e1", "agent", "task1"),
      portsEdge("e2", "task1", "agent"),
    ]);
    const view = canvasDocToCapabilityView(doc);
    expect(HashMap.size(view.edgePortMask)).toBe(0);
    expect(admittedPorts(view).sort()).toEqual(
      ["msg.list", "msg.send", "tasks.claim", "tasks.create", "tasks.list", "tasks.update"].sort(),
    );
  });

  it("one-mask: single masked edge ⇒ exactly that mask", () => {
    const doc = taskDoc([portsEdge("e1", "agent", "task1", ["msg.list"])]);
    const view = canvasDocToCapabilityView(doc);
    expect(admittedPorts(view).sort()).toEqual(["msg.list"]);
  });

  it("two-mask-disjoint: masks union across edges (both ports admit)", () => {
    const doc = taskDoc([
      portsEdge("e1", "agent", "task1", ["msg.list"]),
      portsEdge("e2", "task1", "agent", ["tasks.claim"]),
    ]);
    const view = canvasDocToCapabilityView(doc);
    expect(admittedPorts(view).sort()).toEqual(["msg.list", "tasks.claim"].sort());
  });

  it("two-mask-overlap: union dedupes the shared port, keeps both sides' extras", () => {
    const doc = taskDoc([
      portsEdge("e1", "agent", "task1", ["msg.list", "tasks.claim"]),
      portsEdge("e2", "task1", "agent", ["tasks.claim", "msg.send"]),
    ]);
    const view = canvasDocToCapabilityView(doc);
    expect(admittedPorts(view).sort()).toEqual(
      ["msg.list", "msg.send", "tasks.claim"].sort(),
    );
  });

  it("mask+unmasked: one unmasked edge restores full offers regardless of order", () => {
    const maskedFirst = taskDoc([
      portsEdge("e1", "agent", "task1", ["msg.list"]),
      portsEdge("e2", "task1", "agent"),
    ]);
    const unmaskedFirst = taskDoc([
      portsEdge("e1", "agent", "task1"),
      portsEdge("e2", "task1", "agent", ["msg.list"]),
    ]);
    for (const doc of [maskedFirst, unmaskedFirst]) {
      const view = canvasDocToCapabilityView(doc);
      expect(HashMap.size(view.edgePortMask)).toBe(0);
      expect(admittedPorts(view).sort()).toEqual(
        ["msg.list", "msg.send", "tasks.claim", "tasks.create", "tasks.list", "tasks.update"].sort(),
      );
    }
  });

  it("union can never smuggle a port the target does not offer", () => {
    // page offers only browser.automate; union of two masks that both name
    // ports outside the target's KindSpec.offers must still deny.
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [
        portsEdge("e1", "agent", "p1", ["msg.list"]),
        portsEdge("e2", "p1", "agent", ["msg.send"]),
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    // The union mask is {msg.list, msg.send} — neither is in page's offers.
    const mask = HashMap.get(view.edgePortMask, undirectedEdgeKey("agent", "p1"));
    expect(Option.isSome(mask)).toBe(true);
    if (Option.isSome(mask)) {
      expect(Array.from(mask.value).sort()).toEqual(
        ["msg.list", "msg.send"].sort(),
      );
    }
    const automate = admitPure(view, asNodeId("agent"), asNodeId("p1"), "browser.automate");
    expect(Result.isFailure(automate)).toBe(true);
    if (Result.isFailure(automate)) {
      expect(automate.failure.reason).toBe("no_port");
    }
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
      edges: [{ id: "e1", fromNode: "cc-agent", toNode: "page-b" }],
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
      edges: [{ id: "e1", fromNode: "agent-a", toNode: "page-a" }],
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
