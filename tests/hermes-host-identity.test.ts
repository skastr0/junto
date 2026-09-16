import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { agentKeysForWatcher } from "../src/shared/station";
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
} from "../src/main/junto/hermes/domain";

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

  it("routes a Remote watcher only to its canonical same-host agent", () => {
    const doc = routedDoc("studio", "studio", "fleet-studio:default");
    expect(agentKeysForWatcher(doc, "watcher", "remote", "studio"))
      .toEqual(["fleet-studio:default"]);
    const parsed = parseAgentKey("fleet-studio:default");
    expect(parsed && isLocalHermesHost(parsed.host, station)).toBe(true);
    expect(isLocalHermesHost("local", station)).toBe(false);
  });

  it("keeps Command Center cross-host route keys on the non-local fleet agent", () => {
    const doc = routedDoc("local", "render", "fleet-render:default");
    expect(agentKeysForWatcher(doc, "watcher", "command-center", "local"))
      .toEqual(["fleet-render:default"]);
    const parsed = parseAgentKey("fleet-render:default");
    expect(parsed && isLocalHermesHost(parsed.host, station)).toBe(false);
  });

  it("has no source-level local alias or canonical-to-local rewrite seam", () => {
    const domain = readFileSync(
      join(process.cwd(), "src/main/junto/hermes/domain.ts"),
      "utf8",
    );
    const plane = readFileSync(
      join(process.cwd(), "src/main/junto/hermes/plane.ts"),
      "utf8",
    );
    const chat = readFileSync(
      join(process.cwd(), "src/main/junto/chat/service.ts"),
      "utf8",
    );

    expect(domain).not.toContain("localAdapterAgentKey");
    expect(plane).not.toContain("localAdapterAgentKey");
    expect(chat).not.toContain("defaultHermesHostLocality");
    expect(domain).not.toMatch(
      /host\s*===\s*["']local["']\s*\|\|\s*host\s*===\s*station\.agentHostId/u,
    );
  });
});
