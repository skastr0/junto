import { describe, expect, it } from "vitest";
import { Result, HashMap, HashSet, Option } from "effect";
import {
  PortGrant,
  RuntimePlacement,
  admitPure,
  asNodeId,
  nullPlacementView,
  portSet,
  routeAllowed,
  type NodePlacement,
} from "../../src/shared/physics";
import { resolveHostPlacement } from "../../src/shared/physics/placement";
import { canvasToCapabilityView } from "../../src/shared/physics/view";
import { canvasOf, note, page, region, seat, terminal, wire } from "../support/model-nodes";

const SIZE = { width: 120, height: 48 };
const agent = (id: string, x = 0, y = 0, host = "local") =>
  seat(id, { x, y, ...SIZE, host, agentKey: `${host}:${id}` });
const pageAt = (id: string, x = 200, y = 0, host = "local") =>
  page(id, { x, y, ...SIZE, host });

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
    const doc = canvasOf([agent("agent"), pageAt("p1")], [
        wire("e1", "agent", "p1", "navigates"),
      ]);
    const view = canvasToCapabilityView(doc);
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
    const doc = canvasOf([agent("seat"), pageAt("p1")], [
        wire("e1", "seat", "p1", "navigates"),
      ]);
    const view = canvasToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("seat"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("denies browser.automate to geography — a raw shell is not an actor", () => {
    // No verb joins a terminal to a page, so no wire can.
    const doc = canvasOf([terminal("seat", SIZE), pageAt("p1")]);
    const view = canvasToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("seat"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isFailure(result)).toBe(true);
  });

  it("denies with not_connected when only region co-members (no edge)", () => {
    const doc = canvasOf([
        region("g1", { x: 0, y: 0, width: 400, height: 200 }),
        agent("agent", 40, 40),
        pageAt("p1", 200, 40),
      ], []);
    const view = canvasToCapabilityView(doc);
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
    const doc = canvasOf([agent("agent"), pageAt("p1", 2000, 2000)], []);
    const view = canvasToCapabilityView(doc);
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
    const doc = canvasOf([agent("agent")], []);
    const view = canvasToCapabilityView(doc);
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
    const doc = canvasOf([agent("agent"), pageAt("p1")], [
        wire("e1", "agent", "p1", "navigates"),
      ]);
    const view = canvasToCapabilityView(doc);
    // A page offers browser automation, never a mailbox.
    const result = admitPure(view, asNodeId("agent"), asNodeId("p1"), "msg.send");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("no_port");
    }
  });

  it("denies role_law for geography target with empty offers law", () => {
    const doc = canvasOf([agent("agent"), note("note", "note", { x: 200, y: 0, ...SIZE })], // A stored wire the pair cannot hold: it joins them and grants nothing.
      [wire("e1", "agent", "note", "messages")]);
    const view = canvasToCapabilityView(doc);
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

  it("a verb the pair cannot hold grants nothing", () => {
    const doc = canvasOf([agent("agent"), pageAt("p1")], [wire("e1", "agent", "p1", "edits")]);
    const view = canvasToCapabilityView(doc);
    const denied = admitPure(
      view,
      asNodeId("agent"),
      asNodeId("p1"),
      "browser.automate",
    );
    expect(Result.isFailure(denied)).toBe(true);
  });


  it("actor mail: the messages verb opens both mailbox ports", () => {
    const doc = canvasOf([
        agent("a1"),
        agent("a2", 200, 0),
      ], [
        wire("e1", "a1", "a2", "messages"),
      ]);
    const view = canvasToCapabilityView(doc);
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
    const node = agent("a1");
    const p = resolveHostPlacement(node.host);
    expect(p.runtime._tag).toBe("Cc");
    expect(p.assignment).toBe("local");
  });

  it("non-local host → station, carrying its host id", () => {
    const node = agent("a1", 0, 0, "station-b");
    const p = resolveHostPlacement(node.host);
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
    const doc = canvasOf([
        agent("agent-a", 0, 0, "station-a"),
        pageAt("page-b", 200, 0, "station-b"),
      ], [wire("e1", "agent-a", "page-b", "navigates")]);
    const view = canvasToCapabilityView(doc);
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
    const doc = canvasOf([
        agent("cc-agent", 0, 0, "local"),
        pageAt("page-b", 200, 0, "station-b"),
      ], [
        wire("e1", "cc-agent", "page-b", "navigates"),
      ]);
    const view = canvasToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("cc-agent"),
      asNodeId("page-b"),
      "browser.automate",
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("same-station actor → page: admits", () => {
    const doc = canvasOf([
        agent("agent-a", 0, 0, "station-a"),
        pageAt("page-a", 200, 0, "station-a"),
      ], [
        wire("e1", "agent-a", "page-a", "navigates"),
      ]);
    const view = canvasToCapabilityView(doc);
    const result = admitPure(
      view,
      asNodeId("agent-a"),
      asNodeId("page-a"),
      "browser.automate",
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("placement unknown (omitted map entry) fails closed", () => {
    const doc = canvasOf([agent("agent"), pageAt("page1")], [wire("e1", "agent", "page1", "navigates")]);
    // Only caller placed — target missing → unknown
    let placement = HashMap.empty<ReturnType<typeof asNodeId>, NodePlacement>();
    placement = HashMap.set(
      placement,
      asNodeId("agent"),
      place(RuntimePlacement.Cc(), "local"),
    );
    const view = canvasToCapabilityView(doc, { placement });
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
