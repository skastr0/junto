import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  role: "remote",
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
        watch: { kind: "stat_threshold", source: "hermes" },
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
        terminal: {
          bindingId: `bind-${agentKey.replace(/[^a-z0-9]+/gi, "-")}`,
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
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

  it("falls back to the station's physical hostId when stats carry no canonical hostId", () => {
    expect(snapshotAgentHostId({ key: "fleet-render:default", stats: {} }, "studio"))
      .toBe("studio");
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
    const sendManaged = vi.fn(async () => true);
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
        sendManagedTerminal: sendManaged,
      },
    });

    expect(agentKeysForWatcher(doc, "watcher", "remote", "studio"))
      .toEqual(["fleet-studio:default"]);
    expect(sendManaged).toHaveBeenCalledWith(
      expect.stringContaining("bind-"),
      expect.stringContaining("same host"),
    );
    const parsed = parseAgentKey("fleet-studio:default");
    expect(parsed && isLocalHermesHost(parsed.host, station)).toBe(true);
    expect(isLocalHermesHost("local", station)).toBe(false);
  });

  it("keeps Command Center cross-host delivery on the non-local fleet route", async () => {
    const doc = routedDoc("local", "render", "fleet-render:default");
    const sendManaged = vi.fn(async () => true);
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
        sendManagedTerminal: sendManaged,
      },
    });

    expect(agentKeysForWatcher(doc, "watcher", "command-center", "local"))
      .toEqual(["fleet-render:default"]);
    expect(sendManaged).toHaveBeenCalledWith(
      expect.stringContaining("bind-"),
      expect.stringContaining("cross host"),
    );
    const parsed = parseAgentKey("fleet-render:default");
    expect(parsed && isLocalHermesHost(parsed.host, station)).toBe(false);
  });

  it("has no source-level local alias or canonical-to-local rewrite seam", () => {
    const domain = readFileSync(
      join(process.cwd(), "src/main/vellum/hermes/domain.ts"),
      "utf8",
    );
    const plane = readFileSync(
      join(process.cwd(), "src/main/vellum/hermes/plane.ts"),
      "utf8",
    );
    const identityAdapter = readFileSync(
      join(process.cwd(), "src/main/vellum/adapters/hermes-identity.ts"),
      "utf8",
    );
    const chat = readFileSync(
      join(process.cwd(), "src/main/vellum/chat/service.ts"),
      "utf8",
    );

    expect(domain).not.toContain("localAdapterAgentKey");
    expect(plane).not.toContain("localAdapterAgentKey");
    expect(identityAdapter).not.toMatch(/host\s*===\s*["']local["']/u);
    expect(identityAdapter).not.toMatch(/key:\s*`local:/u);
    expect(chat).not.toContain("defaultHermesHostLocality");
    expect(domain).not.toMatch(
      /host\s*===\s*["']local["']\s*\|\|\s*host\s*===\s*station\.agentHostId/u,
    );
  });
});
