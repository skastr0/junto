import { describe, expect, it } from "vitest";
import { Result, HashMap, HashSet, Option } from "effect";
import {
  ACTOR_ACTOR_INBOX_PORTS,
  PortGrant,
  admitPure,
  asNodeId,
  portSet,
  type Port,
} from "../../src/shared/physics";
import type { Node } from "../../src/shared/model";
import { canvasToCapabilityView } from "../../src/shared/physics/view";
import { OTHER_MACHINE, THIS_MACHINE } from "../support/machines";
import { canvasOf, note, page, region, seat, taskBoard, terminal, wire } from "../support/model-nodes";

/** The canvas is edited on the machine the tests run on, unless a case says otherwise. */
const VIEW = { editingMachine: THIS_MACHINE };

const SIZE = { width: 120, height: 48 };
const agent = (id: string, x = 0, y = 0, host = THIS_MACHINE) =>
  seat(id, { x, y, ...SIZE, host, agentKey: `${host}:${id}` });
const pageAt = (id: string, x = 200, y = 0, host = THIS_MACHINE) =>
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
    const view = canvasToCapabilityView(doc, VIEW);
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
// Two machines: mail crosses, nothing else does

describe("physics across machines", () => {
  const admits = (
    doc: ReturnType<typeof canvasOf>,
    from: string,
    to: string,
    port: Port,
    editingMachine = THIS_MACHINE,
  ) => admitPure(canvasToCapabilityView(doc, { editingMachine }), asNodeId(from), asNodeId(to), port);

  const otherPorts = ACTOR_ACTOR_INBOX_PORTS.filter(
    (port) => port !== "msg.send" && port !== "verdict.post",
  );

  it("same machine: a seat automates a page it is wired to, as before", () => {
    const doc = canvasOf(
      [agent("agent-a", 0, 0, OTHER_MACHINE), pageAt("page-a", 200, 0, OTHER_MACHINE)],
      [wire("e1", "agent-a", "page-a", "navigates")],
    );
    expect(Result.isSuccess(admits(doc, "agent-a", "page-a", "browser.automate"))).toBe(true);
  });

  it("same machine: two wired seats keep every port of the actor inbox", () => {
    const doc = canvasOf([agent("a1"), agent("a2", 200)], [wire("e1", "a1", "a2", "messages")]);
    for (const port of ["msg.send", ...otherPorts] as const) {
      expect(Result.isSuccess(admits(doc, "a1", "a2", port)), port).toBe(true);
      expect(Result.isSuccess(admits(doc, "a2", "a1", port)), port).toBe(true);
    }
  });

  it("two machines: mail is admitted in both directions", () => {
    const doc = canvasOf(
      [agent("here"), agent("there", 200, 0, OTHER_MACHINE)],
      [wire("e1", "here", "there", "messages")],
    );
    expect(Result.isSuccess(admits(doc, "here", "there", "msg.send"))).toBe(true);
    expect(Result.isSuccess(admits(doc, "there", "here", "msg.send"))).toBe(true);
  });

  it("two machines, neither of which edits the canvas: mail is admitted the same way", () => {
    const doc = canvasOf(
      [agent("one", 0, 0, OTHER_MACHINE), agent("two", 200, 0, "render")],
      [wire("e1", "one", "two", "messages")],
    );
    expect(Result.isSuccess(admits(doc, "one", "two", "msg.send"))).toBe(true);
    expect(Result.isSuccess(admits(doc, "two", "one", "msg.send"))).toBe(true);
    // Whichever of the three machines edits the canvas, the answer is the same.
    for (const editingMachine of [THIS_MACHINE, OTHER_MACHINE, "render"]) {
      expect(Result.isSuccess(admits(doc, "one", "two", "msg.send", editingMachine))).toBe(true);
    }
  });

  it("two machines: every other port is denied with other_machine, and says what can be done", () => {
    const doc = canvasOf(
      [agent("here"), agent("there", 200, 0, OTHER_MACHINE)],
      [wire("e1", "here", "there", "messages")],
    );
    expect(otherPorts).toEqual(["msg.list", "msg.prompt", "seat.wait", "terminal.read"]);
    for (const port of otherPorts) {
      for (const [from, to] of [["here", "there"], ["there", "here"]] as const) {
        const result = admits(doc, from, to, port);
        expect(Result.isFailure(result), `${from} ${port}`).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.reason).toBe("other_machine");
          expect(result.failure.message).toMatch(/runs on another machine/);
          expect(result.failure.message).toMatch(/can only be mailed/);
        }
      }
    }
  });

  it("two machines: a seat cannot automate another machine's page", () => {
    const doc = canvasOf(
      [agent("here"), pageAt("page-there", 200, 0, OTHER_MACHINE)],
      [wire("e1", "here", "page-there", "navigates")],
    );
    const result = admits(doc, "here", "page-there", "browser.automate");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.reason).toBe("other_machine");
  });

  it("two machines: mail still needs the wire and what the wire grants", () => {
    const seats = [agent("here"), agent("there", 200, 0, OTHER_MACHINE)];
    // No wire: nothing reaches across.
    const unwired = admits(canvasOf(seats), "here", "there", "msg.send");
    expect(Result.isFailure(unwired)).toBe(true);
    if (Result.isFailure(unwired)) expect(unwired.failure.reason).toBe("invisible");
    // A wire masked down to reading grants no mail to send.
    const masked = admits(
      canvasOf(seats, [wire("e1", "here", "there", "messages", { mask: ["msg.list"] })]),
      "here",
      "there",
      "msg.send",
    );
    expect(Result.isFailure(masked)).toBe(true);
    if (Result.isFailure(masked)) expect(masked.failure.reason).toBe("no_port");
    // A wire whose verb does not carry mail grants none either.
    const page = admits(
      canvasOf([agent("here"), pageAt("page-there", 200, 0, OTHER_MACHINE)], [wire("e1", "here", "page-there", "navigates")]),
      "here",
      "page-there",
      "msg.send",
    );
    expect(Result.isFailure(page)).toBe(true);
    if (Result.isFailure(page)) expect(page.failure.reason).toBe("no_port");
  });

  it("a node that names no machine is on the machine that edits the canvas", () => {
    const doc = canvasOf(
      [agent("worker"), taskBoard("board", { x: 200 })],
      [wire("e1", "board", "worker", "works")],
    );
    // The seat's machine edits the canvas: the board is beside it.
    expect(Result.isSuccess(admits(doc, "worker", "board", "tasks.claim", THIS_MACHINE))).toBe(true);
    // Another machine edits the canvas: the board is there, out of reach of all but mail.
    const elsewhere = admits(doc, "worker", "board", "tasks.claim", OTHER_MACHINE);
    expect(Result.isFailure(elsewhere)).toBe(true);
    if (Result.isFailure(elsewhere)) expect(elsewhere.failure.reason).toBe("other_machine");
  });

  it("a peer, another machine's seat in a copy of the canvas, can be mailed and nothing else", () => {
    const peer = {
      kind: "peer", id: asNodeId("there"), x: 200, y: 0, ...SIZE, z: 0,
      label: "there", host: OTHER_MACHINE, seatId: "seat-there",
    } as unknown as Node;
    const doc = canvasOf([agent("here"), peer], [wire("e1", "here", "there", "messages")]);
    expect(Result.isSuccess(admits(doc, "here", "there", "msg.send"))).toBe(true);
    for (const port of otherPorts) {
      const result = admits(doc, "here", "there", port);
      expect(Result.isFailure(result), port).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("other_machine");
    }
    // The peer's seat acts on its own machine, from the full row that machine
    // holds. From this copy it is never a caller, not even to send mail.
    for (const port of ["msg.send", ...otherPorts] as const) {
      const result = admits(doc, "there", "here", port);
      expect(Result.isFailure(result), port).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe("other_machine");
        expect(result.failure.message).toMatch(/acts from there/);
      }
    }
    // A peer row that claims this machine's name is still only a peer.
    const claiming = { ...peer, host: THIS_MACHINE } as Node;
    const claimed = admits(canvasOf([agent("here"), claiming], [wire("e1", "here", "there", "messages")]), "here", "there", "msg.list");
    expect(Result.isFailure(claimed)).toBe(true);
    if (Result.isFailure(claimed)) expect(claimed.failure.reason).toBe("other_machine");
  });
});
