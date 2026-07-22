import { describe, expect, it } from "vitest";
import { Either, HashMap, HashSet, Option } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { WELL_KNOWN_ENTITY_KINDS } from "../../src/shared/canvas";
import {
  KindSpecs,
  PortForWorkOp,
  PortGrant,
  TARGET_WORK_OPS,
  WELL_KNOWN_KINDS,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  canonicalRolePair,
  defaultGrantBetween,
  defaultGrantForRoles,
  portSet,
  resolveSpec,
  roleOf,
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

  it("maps roles from kind", () => {
    expect(roleOf(resolveSpec({ isGroup: false, kind: "agent" }))).toBe("actor");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "terminal" }))).toBe("actor");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "herdr" }))).toBe("actor");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "page" }))).toBe("sink");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "task" }))).toBe("sink");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "project" }))).toBe("sink");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "watcher" }))).toBe("scheduler");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "timer" }))).toBe("scheduler");
    expect(roleOf(resolveSpec({ isGroup: true, kind: undefined }))).toBe("region");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "note" }))).toBe("furniture");
    expect(roleOf(resolveSpec({ isGroup: false, kind: undefined }))).toBe("furniture");
  });

  it("furniture offers empty", () => {
    const furniture = resolveSpec({ isGroup: false, kind: "label" });
    expect(roleOf(furniture)).toBe("furniture");
    expect(HashSet.size(furniture.offers)).toBe(0);

    const region = resolveSpec({ isGroup: true, kind: undefined });
    expect(HashSet.size(region.offers)).toBe(0);
  });

  it("canvas WELL_KNOWN_ENTITY_KINDS includes watcher and timer", () => {
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("watcher");
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("timer");
  });
});

describe("physics role laws", () => {
  it("actor-sink and actor-actor default to Full", () => {
    expect(defaultGrantBetween(canonicalRolePair("actor", "sink")).isFull()).toBe(true);
    expect(defaultGrantBetween(canonicalRolePair("actor", "actor")).isFull()).toBe(true);
    expect(defaultGrantForRoles("actor", "sink").isFull()).toBe(true);
  });

  it("non-granting pairs are empty", () => {
    expect(defaultGrantForRoles("actor", "furniture").isEmpty()).toBe(true);
    expect(defaultGrantForRoles("actor", "scheduler").isEmpty()).toBe(true);
    expect(defaultGrantForRoles("actor", "region").isEmpty()).toBe(true);
    expect(defaultGrantForRoles("sink", "actor").isEmpty()).toBe(true);
    expect(defaultGrantForRoles("furniture", "sink").isEmpty()).toBe(true);
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
      expect(PortForWorkOp[op]).toBe(op);
    }
    expect(Object.keys(PortForWorkOp).sort()).toEqual([...TARGET_WORK_OPS].sort());
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
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.port).toBe("browser.automate");
      expect(result.right.caller).toBe("agent");
      expect(result.right.target).toBe("p1");
    }
  });

  it("admits terminal and herdr as actors for browser.automate", () => {
    for (const kind of ["terminal", "herdr"] as const) {
      const doc: CanvasDoc = {
        nodes: [textNode("seat", kind), pageNode("p1")],
        edges: [{ id: "e1", fromNode: "seat", toNode: "p1" }],
      };
      const view = canvasDocToCapabilityView(doc);
      const result = admitPure(
        view,
        asNodeId("seat"),
        asNodeId("p1"),
        "browser.automate",
      );
      expect(Either.isRight(result), kind).toBe(true);
    }
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
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("not_connected");
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
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("invisible");
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
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("unknown_node");
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
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("no_port");
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
      expect(Either.isRight(result), port).toBe(true);
    }
  });

  it("denies role_law for furniture target with empty offers law", () => {
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
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("role_law");
    }
  });

  it("attenuates via edge port mask when present", () => {
    const doc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [
        {
          id: "e1",
          fromNode: "agent",
          toNode: "p1",
          // Future field — not yet on EtherEdgeExtension schema.
          ether: { ports: ["msg.send"] },
        },
      ],
    } as unknown as CanvasDoc;
    const view = canvasDocToCapabilityView(doc);
    // browser.automate not in mask
    const denied = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Either.isLeft(denied)).toBe(true);
    if (Either.isLeft(denied)) {
      expect(denied.left.reason).toBe("no_port");
    }
  });

  it("view leaves edgePortMask empty when ports field absent", () => {
    const doc: CanvasDoc = {
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [{ id: "e1", fromNode: "agent", toNode: "p1" }],
    };
    const view = canvasDocToCapabilityView(doc);
    expect(HashMap.size(view.edgePortMask)).toBe(0);
  });
});

describe("physics KindSpecs offers match behavior-preserving work surface", () => {
  it("page offers only browser.automate", () => {
    expect(HashSet.toValues(KindSpecs.page.offers).sort()).toEqual([
      "browser.automate",
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
