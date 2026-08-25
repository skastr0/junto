import { beforeEach, describe, expect, it } from "vitest";
import {
  actorRailsOpen,
  setActorRailOpen,
  terminal$,
} from "../src/renderer/lib/terminal-state";
import { actorTerminalRailsPx } from "../src/renderer/lib/focus-measure";

const NODE = "agent-01KYWFGGE0CTS3R1G4RWYFDQM8";

describe("actor rail state", () => {
  beforeEach(() => {
    terminal$.railsOpenByNodeId.set({});
  });

  it("reads as expanded before either rail has been touched", () => {
    expect(actorRailsOpen(NODE)).toEqual({ ledger: true, connections: true });
  });

  it("keeps the other rail's state when one toggles", () => {
    setActorRailOpen(NODE, "ledger", false);
    expect(actorRailsOpen(NODE)).toEqual({ ledger: false, connections: true });

    setActorRailOpen(NODE, "connections", false);
    expect(actorRailsOpen(NODE)).toEqual({ ledger: false, connections: false });

    setActorRailOpen(NODE, "ledger", true);
    expect(actorRailsOpen(NODE)).toEqual({ ledger: true, connections: false });
  });

  it("is per node — one seat's collapsed rail is not another's", () => {
    setActorRailOpen(NODE, "ledger", false);
    expect(actorRailsOpen("agent-other").ledger).toBe(true);
  });

  // Node-keyed so a collapsed rail survives closing and re-opening the
  // surface; pane-local state reset to expanded on every mount.
  it("survives a surface close", () => {
    setActorRailOpen(NODE, "connections", false);
    terminal$.openByNodeId[NODE].delete();
    expect(actorRailsOpen(NODE).connections).toBe(false);
  });

  it("keeps one panel budget while stacked sections collapse", () => {
    const expanded = actorTerminalRailsPx(actorRailsOpen(NODE));
    setActorRailOpen(NODE, "ledger", false);
    expect(actorTerminalRailsPx(actorRailsOpen(NODE))).toBe(expanded);
  });
});
