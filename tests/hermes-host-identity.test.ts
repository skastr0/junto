import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  agentKeysForWatcher,
} from "../src/shared/station";
import {
  buildPortfolioDoc,
  hermesAgentsFromSnapshots,
  snapshotAgentHostId,
} from "../src/shared/portfolio";
import { buildConnectionIndex } from "../src/shared/connections";
import {
  isLocalHermesHost,
  parseAgentKey,
  resolveHermesStationIdentity,
} from "../src/main/vellum/hermes/domain";
import {
  __resetKernelMemoryForTest,
  __setDocsForTest,
  __setStationScopeForTest,
  deliverPulse,
  setArmed,
} from "../src/main/vellum/kernel/cycle";

const station = resolveHermesStationIdentity({
  hostId: "studio",
  agentHostId: "fleet-studio",
});

const routedDoc = (
  watcherHost: string,
  agentHost: string,
  agentKey: string,
): CanvasDoc => ({
  nodes: [
    {
      id: "region",
      type: "group",
      x: 0,
      y: 0,
      width: 500,
      height: 500,
      ether: { region: { instruction: "inspect the station" } },
    },
    {
      id: "watcher",
      type: "text",
      text: "watcher",
      x: 20,
      y: 20,
      width: 120,
      height: 80,
      ether: {
        entity: { kind: "watcher" },
        host: watcherHost,
        watch: { kind: "glyphs_done" },
      },
    },
    {
      id: "agent",
      type: "text",
      text: "agent",
      x: 20,
      y: 140,
      width: 120,
      height: 80,
      ether: {
        entity: { kind: "agent", name: agentKey },
        host: agentHost,
      },
    },
  ],
  edges: [{ id: "route", fromNode: "watcher", toNode: "agent" }],
});

beforeEach(() => {
  __resetKernelMemoryForTest();
});

describe("canonical Hermes station identity", () => {
  it("uses physical hostId for portfolio execution, never the display label", () => {
    const entity = {
      source: "hermes" as const,
      key: "fleet-studio:default",
      kind: "agent",
      title: "default",
      stats: {
        host: "Studio Display Name",
        hostId: "studio",
      },
      updatedAt: "2026-07-23T00:00:00.000Z",
    };

    expect(snapshotAgentHostId(entity, "wrong-station")).toBe("studio");
    const doc = buildPortfolioDoc({
      bundles: [{
        source: "hermes",
        fetchedAt: entity.updatedAt,
        ok: true,
        entities: [entity],
      }],
    });
    expect(doc.nodes[0]?.ether).toMatchObject({
      entity: { name: "fleet-studio:default" },
      host: "studio",
    });
    const added = doc.nodes[0];
    expect(added?.type).toBe("text");
    if (added?.type === "text") {
      expect(added.text).toContain("Studio Display Name");
    }
  });

  it("rebinds only the legacy local key to the caller's physical station", () => {
    expect(snapshotAgentHostId({ key: "local:default", stats: {} }, "studio"))
      .toBe("studio");
    expect(snapshotAgentHostId({ key: "fleet-render:default", stats: {} }, "studio"))
      .toBe("fleet-render");
  });

  it("keeps successful Hermes facts visible when another fleet host made the bundle partial", () => {
    const state = {
      bundles: [{
        source: "hermes" as const,
        fetchedAt: "2026-07-23T00:00:00.000Z",
        ok: false,
        stale: true,
        error: "hermes host refresh failed (fleet-render)",
        entities: [{
          source: "hermes" as const,
          key: "fleet-studio:default",
          kind: "agent",
          title: "default",
          stats: { host: "Studio", hostId: "studio", running: 1 },
          updatedAt: "2026-07-23T00:00:00.000Z",
          stale: false,
        }],
      }],
    };

    expect(hermesAgentsFromSnapshots(state).map((entity) => entity.key))
      .toEqual(["fleet-studio:default"]);
    expect(buildPortfolioDoc(state).nodes[0]?.ether).toMatchObject({
      entity: { name: "fleet-studio:default" },
      host: "studio",
    });
    expect(buildConnectionIndex(state).byKey.get("hermes:fleet-studio:default"))
      .toMatchObject({ stale: false });
  });

  it("delivers a Remote watcher to its canonical same-host agent locally", async () => {
    const doc = routedDoc("studio", "studio", "fleet-studio:default");
    const openChat = vi.fn(async () => undefined);
    const sendPrompt = vi.fn(async () => undefined);
    __setDocsForTest(new Map([["work", doc]]));
    __setStationScopeForTest({ hostId: "studio", role: "remote" });
    setArmed("work::region", true);

    await deliverPulse({
      canvasName: "work",
      sourceNodeId: "watcher",
      kind: "watcher",
      regionId: "region",
      summary: "same host",
      deps: {
        isLive: () => false,
        openChat,
        sendPrompt,
      },
    });

    expect(agentKeysForWatcher(doc, "watcher", "remote", "studio"))
      .toEqual(["fleet-studio:default"]);
    expect(openChat).toHaveBeenCalledWith("fleet-studio:default");
    expect(sendPrompt).toHaveBeenCalledWith(
      "fleet-studio:default",
      expect.stringContaining("same host"),
      expect.any(Array),
    );
    const parsed = parseAgentKey("fleet-studio:default");
    expect(parsed && isLocalHermesHost(parsed.host, station)).toBe(true);
  });

  it("keeps Command Center cross-host delivery on the non-local fleet route", async () => {
    const doc = routedDoc("local", "render", "fleet-render:default");
    const sendPrompt = vi.fn(async () => undefined);
    __setDocsForTest(new Map([["work", doc]]));
    __setStationScopeForTest({ hostId: "local", role: "command-center" });
    setArmed("work::region", true);

    await deliverPulse({
      canvasName: "work",
      sourceNodeId: "watcher",
      kind: "watcher",
      regionId: "region",
      summary: "cross host",
      deps: {
        isLive: () => true,
        openChat: async () => undefined,
        sendPrompt,
      },
    });

    expect(agentKeysForWatcher(doc, "watcher", "command-center", "local"))
      .toEqual(["fleet-render:default"]);
    expect(sendPrompt).toHaveBeenCalledWith(
      "fleet-render:default",
      expect.stringContaining("cross host"),
      expect.any(Array),
    );
    const parsed = parseAgentKey("fleet-render:default");
    expect(parsed && isLocalHermesHost(parsed.host, station)).toBe(false);
  });
});
