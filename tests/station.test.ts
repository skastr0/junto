import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  assessSupervisedRuntime,
  resolveNodeHostId,
} from "../src/shared/station";
import { defaultSettings, applySettingsPatch } from "../src/shared/settings";
import {
  makeManagedAgentNode,
  makePageNode,
  makeGaugeNode,
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
    const watcher = makeGaugeNode(0, 0, "remote-a");
    expect(agent.ether?.host).toBe("local");
    expect(page.ether?.host).toBe("local");
    expect(watcher.ether?.host).toBe("remote-a");
  });

  it("separates an actor's placement HostId from its Hermes routing key", () => {
    const agent = makeManagedAgentNode(0, 0, {
      harness: "hermes",
      host: "box-1",
      agentHost: "hermes-box",
      profile: "operator",
    });

    expect(agent.ether?.host).toBe("box-1");
    expect(agent.ether?.entity?.name).toBe("hermes-box:operator");
  });

  it("refuses to create an actor without a canonical placement host", () => {
    expect(() =>
      makeManagedAgentNode(0, 0, {
        harness: "codex",
        host: "",
      }),
    ).toThrow("invalid station host id");
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
