import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import {
  actorRailExpanded,
  actorRailMode,
  actorRailPeers,
  setActorRailExpanded,
} from "../src/renderer/lib/actor-rail";
import { sidebarSections$ } from "../src/renderer/lib/sidebar-sections";

const agent = (id: string): CanvasNode => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 240,
  height: 72,
  text: id,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    host: "local",
    terminal: { bindingId: `local:${id}`, harness: "codex" },
  },
});
const note: CanvasNode = { id: "note", type: "text", x: 0, y: 0, width: 200, height: 80, text: "Notes" };
const edge = (id: string, fromNode: string, toNode: string) => ({ id, fromNode, toNode });

const doc: CanvasDoc = {
  nodes: [agent("lead"), agent("ada"), agent("bea"), agent("solo"), note],
  edges: [edge("e1", "lead", "ada"), edge("e2", "bea", "lead"), edge("e3", "lead", "ada"), edge("e4", "lead", "note")],
};

describe("agent rail peers", () => {
  it("lists each connected agent once, whichever way the wire runs, and other connections apart", () => {
    const peers = actorRailPeers(doc, "lead");
    expect(peers.agents.map((peer) => peer.id).sort()).toEqual(["ada", "bea"]);
    expect(peers.others.map((row) => row.peerId)).toEqual(["note"]);
  });

  it("a seat with no connections has no rail; a node that is not an agent has none either", () => {
    expect(actorRailMode(doc, "solo", true)).toBe("none");
    expect(actorRailMode(doc, "note", true)).toBe("none");
    expect(actorRailMode(doc, "missing", true)).toBe("none");
  });

  it("is expanded or a strip by the one stored choice", () => {
    expect(actorRailMode(doc, "lead", true)).toBe("expanded");
    expect(actorRailMode(doc, "lead", false)).toBe("collapsed");
  });
});

describe("agent rail expand choice", () => {
  afterEach(() => sidebarSections$.open.set({}));

  it("starts expanded and is one choice for every agent", () => {
    expect(actorRailExpanded()).toBe(true);
    setActorRailExpanded(false);
    expect(actorRailExpanded()).toBe(false);
    setActorRailExpanded(true);
    expect(actorRailExpanded()).toBe(true);
  });
});
