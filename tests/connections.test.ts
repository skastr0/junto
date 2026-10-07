import { describe, expect, it } from "vitest";
import type { Entity, SnapshotState } from "../src/shared/entities";
import { buildConnectionIndex, seatIdentityHints } from "../src/shared/connections";
import { canvasOf, note, seat } from "./support/model-nodes";

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

describe("buildConnectionIndex", () => {
  it("holds each live entity by its source and key", () => {
    const index = buildConnectionIndex(state([entity("remote-a:vega")]));
    expect(index.byKey.get("hermes:remote-a:vega")).toMatchObject({ key: "remote-a:vega" });
  });

  it("a down bundle contributes nothing, bar the rows it marked current", () => {
    const index = buildConnectionIndex(
      state([entity("remote-a:vega"), entity("remote-a:lyra", { stale: false })], true),
    );
    expect(index.byKey.has("hermes:remote-a:vega")).toBe(false);
    expect(index.byKey.has("hermes:remote-a:lyra")).toBe(true);
  });
});

describe("seatIdentityHints", () => {
  it("names each seat's agent once across canvases, whether or not it is live", () => {
    const hints = seatIdentityHints([
      canvasOf([seat("a", { agentKey: "remote-a:vega" }), note("n")]),
      canvasOf([seat("b", { agentKey: "remote-a:vega" }), seat("c", { agentKey: "studio:profile-13" })]),
    ]);
    expect(hints).toEqual([
      { source: "hermes", key: "remote-a:vega" },
      { source: "hermes", key: "studio:profile-13" },
    ]);
  });

  it("a canvas with no seat produces no hints", () => {
    expect(seatIdentityHints([canvasOf([note("card")])])).toEqual([]);
  });
});
