import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import {
  agentKeysForWatcher,
  assessSupervisedRuntime,
  isExecutableNode,
  isNodeEligibleOnStation,
  resolveNodeHostId,
  watcherMayTargetAgent,
} from "../src/shared/station";
import { defaultSettings, applySettingsPatch } from "../src/shared/settings";
import {
  makeHerdrNode,
  makeManagedAgentNode,
  makePageNode,
  makeWatcherNode,
} from "../src/renderer/lib/node-factories";

describe("station role settings", () => {
  it("defaults to unset role and local host id", () => {
    const settings = defaultSettings();
    expect(settings.station.role).toBe("");
    expect(settings.station.hostId).toBe("local");
    expect(settings.station.supervisedPreferred).toBe(false);
  });

  it("patches station role only when the human sets it", () => {
    const next = applySettingsPatch(defaultSettings(), {
      station: { role: "command-center", supervisedPreferred: false },
    });
    expect(next.station.role).toBe("command-center");
    expect(next.station.hostId).toBe("local");
  });
});

describe("node host assignment", () => {
  it("factories stamp host on executable nodes", () => {
    const agent = makeManagedAgentNode(0, 0, {
      harness: "claude",
      host: "local",
      profile: "codex",
      label: "codex",
    });
    const page = makePageNode(0, 0, "https://example.com");
    const watcher = makeWatcherNode(0, 0, "remote-a");
    const herdr = makeHerdrNode(0, 0, {
      host: "remote-a",
      paneId: "w1:p1",
    });

    expect(agent.ether?.host).toBe("local");
    expect(page.ether?.host).toBe("local");
    expect(watcher.ether?.host).toBe("remote-a");
    expect(herdr.ether?.host).toBe("remote-a");
    expect(resolveNodeHostId(herdr)).toBe("remote-a");
  });

  it("legacy nodes without ether.host resolve to local", () => {
    const node = {
      id: "n1",
      type: "text",
      text: "legacy agent",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: { entity: { kind: "agent", name: "local:codex" } },
    } as CanvasNode;
    expect(resolveNodeHostId(node)).toBe("local");
    expect(isExecutableNode(node)).toBe(true);
    expect(isNodeEligibleOnStation(node, "local")).toBe(true);
    expect(isNodeEligibleOnStation(node, "remote-a")).toBe(false);
  });

  it("legacy agent key host prefix resolves when ether.host absent", () => {
    const node = {
      id: "n1b",
      type: "text",
      text: "remote agent",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: { entity: { kind: "agent", name: "remote-a:codex" } },
    } as CanvasNode;
    expect(resolveNodeHostId(node)).toBe("remote-a");
    expect(isNodeEligibleOnStation(node, "remote-a")).toBe(true);
    expect(isNodeEligibleOnStation(node, "local")).toBe(false);
  });

  it("herdr.host fills resolve when ether.host absent", () => {
    const node = {
      id: "n2",
      type: "text",
      text: "herdr",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "herdr" },
        herdr: { host: "remote-a", paneId: "w1:p2" },
      },
    } as CanvasNode;
    expect(resolveNodeHostId(node)).toBe("remote-a");
  });
});

describe("watcher target rules", () => {
  it("command center may target any agent host", () => {
    expect(
      watcherMayTargetAgent({
        stationRole: "command-center",
        stationHostId: "local",
        watcherHostId: "local",
        agentHostId: "remote-a",
      }),
    ).toBe(true);
  });

  it("remote may only target same-host agents", () => {
    expect(
      watcherMayTargetAgent({
        stationRole: "remote",
        stationHostId: "remote-a",
        watcherHostId: "remote-a",
        agentHostId: "remote-a",
      }),
    ).toBe(true);
    expect(
      watcherMayTargetAgent({
        stationRole: "remote",
        stationHostId: "remote-a",
        watcherHostId: "remote-a",
        agentHostId: "local",
      }),
    ).toBe(false);
  });
});

describe("watcher to agent edge routing", () => {
  const doc: CanvasDoc = {
    nodes: [
      {
        id: "w1",
        type: "text",
        text: "watch",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        ether: { entity: { kind: "watcher" }, host: "local", watch: { kind: "glyphs_done" } },
      },
      {
        id: "a1",
        type: "text",
        text: "agent local",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        ether: { entity: { kind: "agent", name: "local:codex" }, host: "local" },
      },
      {
        id: "a2",
        type: "text",
        text: "agent mini",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        ether: { entity: { kind: "agent", name: "remote-a:codex" }, host: "remote-a" },
      },
    ],
    edges: [
      { id: "e1", fromNode: "w1", toNode: "a1" },
      { id: "e2", fromNode: "w1", toNode: "a2" },
    ],
  };

  it("command center may reach both agents via edges", () => {
    const keys = agentKeysForWatcher(doc, "w1", "command-center", "local");
    expect(keys).toContain("local:codex");
    expect(keys).toContain("remote-a:codex");
  });

  it("remote only reaches same-host agents", () => {
    const keys = agentKeysForWatcher(doc, "w1", "remote", "local");
    expect(keys).toEqual(["local:codex"]);
  });

  it("returns empty when no edges", () => {
    const isolated: CanvasDoc = { nodes: doc.nodes, edges: [] };
    expect(agentKeysForWatcher(isolated, "w1", "command-center", "local")).toEqual([]);
  });
});

describe("supervised runtime assessment", () => {
  it("aligns when preferred and LaunchAgent loaded", () => {
    const result = assessSupervisedRuntime({
      role: "remote",
      hostId: "remote-a",
      supervisedPreferred: true,
      supervisedInstalled: "installed",
    });
    expect(result.aligned).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.metadata.role).toBe("remote");
    expect(result.metadata.hostId).toBe("remote-a");
    expect(result.metadata.supervisedPreferred).toBe("true");
    expect(result.metadata.supervisedInstalled).toBe("installed");
    expect(result.metadata.supervisedAligned).toBe("true");
  });

  it("warns when Remote prefers supervised but agent is absent", () => {
    const result = assessSupervisedRuntime({
      role: "remote",
      hostId: "remote-a",
      supervisedPreferred: true,
      supervisedInstalled: "absent",
    });
    expect(result.aligned).toBe(false);
    expect(result.status).toBe("warning");
    expect(result.detail).toContain("app:install:supervised");
    expect(result.metadata.supervisedAligned).toBe("false");
  });

  it("treats unsupervised preference with absent agent as aligned", () => {
    const result = assessSupervisedRuntime({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
    });
    expect(result.aligned).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("warns when preferred but install state is unknown", () => {
    const result = assessSupervisedRuntime({
      role: "remote",
      hostId: "local",
      supervisedPreferred: true,
      supervisedInstalled: "unknown",
    });
    expect(result.aligned).toBe(false);
    expect(result.status).toBe("warning");
    expect(result.metadata.supervisedInstalled).toBe("unknown");
  });

  it("maps empty role to unset in metadata", () => {
    const result = assessSupervisedRuntime({
      role: "",
      hostId: "local",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
    });
    expect(result.role).toBe("unset");
    expect(result.metadata.role).toBe("unset");
  });
});
