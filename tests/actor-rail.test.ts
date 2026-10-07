import { afterEach, describe, expect, it } from "vitest";
import { board, canvasOf, seat, wire } from "./support/model-nodes";
import {
  actorRailExpanded,
  actorRailMode,
  actorRailPeers,
  setActorRailExpanded,
} from "../src/renderer/lib/actor-rail";
import { sidebarSections$ } from "../src/renderer/lib/sidebar-sections";

const doc = canvasOf(
  [seat("lead"), seat("ada"), seat("bea"), seat("solo"), board("notes")],
  [
    wire("e1", "lead", "ada", "messages"),
    wire("e2", "bea", "lead", "messages"),
    wire("e3", "lead", "ada", "reviews"),
    wire("e4", "lead", "notes", "participates"),
  ],
);

describe("agent rail peers", () => {
  it("lists each connected agent once, whichever way the wire runs, and other connections apart", () => {
    const peers = actorRailPeers(doc, "lead");
    expect(peers.agents.map((peer) => peer.id).sort()).toEqual(["ada", "bea"]);
    expect(peers.others.map((row) => row.peerId)).toEqual(["notes"]);
  });

  it("a seat with no connections has no rail; a node that is not an agent has none either", () => {
    expect(actorRailMode(doc, "solo", true)).toBe("none");
    expect(actorRailMode(doc, "notes", true)).toBe("none");
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
