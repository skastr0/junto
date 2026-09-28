import { describe, expect, it } from "vitest";
import { Result, HashMap, HashSet, Option } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import {
  PortGrant,
  RuntimePlacement,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  nullPlacementView,
  portSet,
  resolveNodePlacement,
  routeAllowed,
  type NodePlacement,
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
      nodes: [textNode("agent", "agent"), pageNode("p1")],
      edges: [
        { id: "e1", fromNode: "agent", toNode: "p1", ether: { verb: "navigates" } },
      ],
    };
    const view = canvasDocToCapabilityView(doc);
    // A page offers browser automation, never a mailbox.
    const result = admitPure(view, asNodeId("agent"), asNodeId("p1"), "msg.send");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("no_port");
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
