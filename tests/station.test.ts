import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  allowAuthorialCliWrite,
  AUTHORIAL_WRITE_ENV,
} from "../src/shared/authorial-write";
import {
  isExecutableNode,
  isNodeEligibleOnStation,
  resolveNodeHostId,
  watcherMayTargetAgent,
} from "../src/shared/station";
import { defaultSettings, applySettingsPatch } from "../src/shared/settings";
import { migrateSettingsDocument } from "../src/main/vellum/settings/migrate";
import { Either } from "effect";
import { makeAgentNode, makeHerdrNode, makePageNode, makeWatcherNode } from "../src/renderer/lib/node-factories";

describe("station role settings", () => {
  it("defaults to unset role and local host id", () => {
    const settings = defaultSettings();
    expect(settings.station.role).toBe("");
    expect(settings.station.hostId).toBe("local");
    expect(settings.station.commandCenterRef).toBe("");
    expect(settings.station.supervisedPreferred).toBe(false);
  });

  it("soft-heals missing station section on migrate", () => {
    const result = migrateSettingsDocument({ version: 1, appearance: { theme: "system" } });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.station.role).toBe("");
      expect(result.right.station.hostId).toBe("local");
      expect(result.right.appearance.theme).toBe("system");
    }
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
    const agent = makeAgentNode(0, 0, "codex", "local:codex");
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

describe("authorial write gate", () => {
  it("denies CLI write without opt-in env", () => {
    const gate = allowAuthorialCliWrite({});
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("authorial_write_denied");
  });

  it("allows CLI write with VELLUM_AUTHORIAL_WRITE=1", () => {
    const gate = allowAuthorialCliWrite({ [AUTHORIAL_WRITE_ENV]: "1" });
    expect(gate.ok).toBe(true);
  });
});
