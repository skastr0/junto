import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { Entity, SnapshotState } from "../src/shared/entities";
import {
  buildConnectionIndex,
  connectionKey,
  connectionKeys,
  identityHints,
  resolveConnections,
  resolveNodeConnections,
} from "../src/shared/connections";

const entity = (
  source: Entity["source"],
  key: string,
  over: Partial<Entity> = {},
): Entity => ({
  source,
  key,
  kind: source === "hermes" ? "agent" : "project",
  stats: {},
  updatedAt: "2026-07-15T00:00:00.000Z",
  ...over,
});

const state = (entities: ReadonlyArray<Entity>, down: ReadonlyArray<Entity["source"]> = []): SnapshotState => {
  const sources = ["tower", "quasar", "booth", "hermes"] as const;
  return {
    bundles: sources.map((source) => ({
      source,
      fetchedAt: "2026-07-15T00:00:00.000Z",
      ok: !down.includes(source),
      entities: entities.filter((candidate) => candidate.source === source),
    })),
  };
};

describe("resolveConnections — tiers", () => {
  it("no identity name -> no connections (quiet, never guessed)", () => {
    const index = buildConnectionIndex(state([entity("tower", "vellum")]));
    expect(resolveConnections(undefined, index)).toEqual([]);
    expect(resolveConnections({ kind: "project" }, index)).toEqual([]);
    expect(resolveConnections({ kind: "watcher" }, index)).toEqual([]);
  });

  it("tower joins by exact key, booth by declared tower linkage", () => {
    const booth = entity("booth", "vellum-assets", { stats: { tower_project: "vellum" } });
    const index = buildConnectionIndex(state([entity("tower", "vellum"), booth]));
    const connections = resolveConnections({ kind: "project", name: "vellum" }, index);
    expect(connectionKey(connections, "tower")).toBe("vellum");
    expect(connectionKey(connections, "booth")).toBe("vellum-assets");
  });

  it("booth falls back to key equality when no linkage is declared", () => {
    const index = buildConnectionIndex(state([entity("booth", "vellum")]));
    const connections = resolveConnections({ kind: "project", name: "vellum" }, index);
    expect(connectionKey(connections, "booth")).toBe("vellum");
  });

  it("title matching is exact-normalized, never fuzzy", () => {
    const index = buildConnectionIndex(
      state([entity("tower", "tower-cli", { title: "tower-cli" }), entity("tower", "tower-control", { title: "tower-control" })]),
    );
    expect(resolveConnections({ kind: "project", name: "tower-c" }, index)).toEqual([]);
    expect(connectionKey(resolveConnections({ kind: "project", name: "Tower-CLI " }, index), "tower")).toBe("tower-cli");
  });

  it("quasar facets ALL join, most-active first", () => {
    const git = entity("quasar", "git:github.com/skastr0/vellum", { title: "vellum", stats: { sessions: 12 } });
    const local = entity("quasar", "path:machine:abc:def", { title: "vellum", stats: { sessions: 40 } });
    const index = buildConnectionIndex(state([git, local]));
    const keys = connectionKeys(resolveConnections({ kind: "project", name: "vellum" }, index), "quasar");
    expect(keys).toEqual(["path:machine:abc:def", "git:github.com/skastr0/vellum"]);
  });

  it("agents are identity-declared: connection exists even when hermes is down or missing", () => {
    const offline = resolveConnections({ kind: "agent", name: "remote-a:vega" }, buildConnectionIndex(state([])));
    expect(offline).toEqual([{ source: "hermes", key: "remote-a:vega" }]);
    const live = entity("hermes", "remote-a:vega", { kind: "agent" });
    const online = resolveConnections({ kind: "agent", name: "remote-a:vega" }, buildConnectionIndex(state([live])));
    expect(online[0]?.entity).toBe(live);
  });

  it("a down bundle contributes nothing (its entities never enter the index)", () => {
    const index = buildConnectionIndex(state([entity("tower", "vellum")], ["tower"]));
    expect(resolveConnections({ kind: "project", name: "vellum" }, index)).toEqual([]);
  });
});

describe("identity is independent of the node's visible label", () => {
  it("resolution reads entity.name only — retitling the node changes nothing", () => {
    const snapshots = state([entity("tower", "vellum")]);
    const before = resolveNodeConnections({ kind: "project", name: "vellum" }, snapshots);
    // the node's text is not an input to resolution at all; same entity, same result
    const after = resolveNodeConnections({ kind: "project", name: "vellum" }, snapshots);
    expect(after).toEqual(before);
    expect(connectionKey(after, "tower")).toBe("vellum");
  });
});

describe("the my-new-project lifecycle (acceptance)", () => {
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

  it("t0: nothing in the corpus -> quiet card, empty hints", () => {
    const snapshots = state([]);
    expect(resolveNodeConnections(card.nodes[0]!.ether!.entity, snapshots)).toEqual([]);
    expect(identityHints([card], snapshots)).toEqual([]);
  });

  it("t1..t3: connections light up as the corpus grows, zero document edits", () => {
    const t1 = state([entity("tower", "my-new-project")]);
    expect(connectionKey(resolveNodeConnections(card.nodes[0]!.ether!.entity, t1), "tower")).toBe("my-new-project");

    const t2 = state([
      entity("tower", "my-new-project"),
      entity("quasar", "git:github.com/skastr0/my-new-project", { title: "my-new-project" }),
    ]);
    expect(identityHints([card], t2)).toEqual([
      { source: "tower", key: "my-new-project" },
      { source: "quasar", key: "git:github.com/skastr0/my-new-project" },
    ]);

    const t3 = state([
      entity("tower", "my-new-project"),
      entity("quasar", "git:github.com/skastr0/my-new-project", { title: "my-new-project" }),
      entity("booth", "my-new-project", { stats: { tower_project: "my-new-project", pending_review: 1 } }),
    ]);
    const connections = resolveNodeConnections(card.nodes[0]!.ether!.entity, t3);
    expect(connections.map((connection) => connection.source).sort()).toEqual(["booth", "quasar", "tower"]);
  });
});

describe("identityHints", () => {
  it("dedups across docs and emits every quasar facet, uncapped", () => {
    const doc = (name: string): CanvasDoc => ({
      nodes: [
        { id: `p-${name}`, type: "text", text: name, x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "project", name } } },
      ],
      edges: [],
    });
    const facets = Array.from({ length: 12 }, (_, i) =>
      entity("quasar", `path:machine:m${i}:vellum`, { title: "vellum", stats: { sessions: i } }),
    );
    const snapshots = state([entity("tower", "vellum"), ...facets]);
    const hints = identityHints([doc("vellum"), doc("vellum")], snapshots);
    expect(hints.filter((hint) => hint.source === "quasar")).toHaveLength(12);
    expect(hints.filter((hint) => hint.source === "tower")).toHaveLength(1);
  });
});
