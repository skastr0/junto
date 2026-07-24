import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { Entity, SnapshotState } from "../src/shared/entities";
import {
  buildConnectionIndex,
  connectionKey,
  identityHints,
  resolveConnections,
  resolveNodeConnections,
} from "../src/shared/connections";

const entity = (
  key: string,
  over: Partial<Entity> = {},
): Entity => ({
  source: "hermes",
  key,
  kind: "agent",
  stats: {},
  updatedAt: "2026-07-15T00:00:00.000Z",
  ...over,
});

const state = (entities: ReadonlyArray<Entity>, down = false): SnapshotState => ({
  bundles: [
    {
      source: "hermes",
      fetchedAt: "2026-07-15T00:00:00.000Z",
      ok: !down,
      entities,
    },
  ],
});

describe("resolveConnections — hermes-only", () => {
  it("no identity name -> no connections (quiet, never guessed)", () => {
    const index = buildConnectionIndex(state([entity("remote-a:vega")]));
    expect(resolveConnections(undefined, index)).toEqual([]);
    expect(resolveConnections({ kind: "project" }, index)).toEqual([]);
    expect(resolveConnections({ kind: "watcher" }, index)).toEqual([]);
  });

  it("project cards do not join the live corpus", () => {
    const index = buildConnectionIndex(state([entity("remote-a:vega")]));
    expect(resolveConnections({ kind: "project", name: "vellum" }, index)).toEqual([]);
  });

  it("agents are identity-declared: connection exists even when hermes is down or missing", () => {
    const offline = resolveConnections({ kind: "agent", name: "remote-a:vega" }, buildConnectionIndex(state([])));
    expect(offline).toEqual([{ source: "hermes", key: "remote-a:vega" }]);
    const live = entity("remote-a:vega");
    const online = resolveConnections({ kind: "agent", name: "remote-a:vega" }, buildConnectionIndex(state([live])));
    expect(online[0]?.entity).toBe(live);
  });

  it("a down bundle contributes nothing (its entities never enter the index)", () => {
    const index = buildConnectionIndex(state([entity("remote-a:vega")], true));
    const connections = resolveConnections({ kind: "agent", name: "remote-a:vega" }, index);
    // Key survives offline fleet; entity is absent
    expect(connections).toEqual([{ source: "hermes", key: "remote-a:vega" }]);
  });
});

describe("identity is independent of the node's visible label", () => {
  it("resolution reads entity.name only — retitling the node changes nothing", () => {
    const snapshots = state([entity("remote-a:vega")]);
    const before = resolveNodeConnections({ kind: "agent", name: "remote-a:vega" }, snapshots);
    const after = resolveNodeConnections({ kind: "agent", name: "remote-a:vega" }, snapshots);
    expect(after).toEqual(before);
    expect(connectionKey(after, "hermes")).toBe("remote-a:vega");
  });
});

describe("identityHints", () => {
  it("emits hermes agent keys only, deduped across docs", () => {
    const doc = (name: string): CanvasDoc => ({
      nodes: [
        {
          id: `a-${name}`,
          type: "text",
          text: name,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "agent", name } },
        },
      ],
      edges: [],
    });
    const snapshots = state([entity("remote-a:vega"), entity("studio:mira")]);
    const hints = identityHints([doc("remote-a:vega"), doc("remote-a:vega"), doc("studio:mira")], snapshots);
    expect(hints).toEqual([
      { source: "hermes", key: "remote-a:vega" },
      { source: "hermes", key: "studio:mira" },
    ]);
  });

  it("project cards produce no hints", () => {
    const card: CanvasDoc = {
      nodes: [
        {
          id: "n1",
          type: "text",
          text: "my-new-project",
          x: 0,
          y: 0,
          width: 240,
          height: 96,
          ether: { entity: { kind: "project", name: "my-new-project" } },
        },
      ],
      edges: [],
    };
    expect(identityHints([card], state([]))).toEqual([]);
  });
});
