import { describe, expect, it } from "bun:test";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";

const entry = (id: string) => {
  const match = DEFAULT_NODE_CATALOG_ENTRIES.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`missing catalog entry: ${id}`);
  return match;
};

describe("node palette catalog contract", () => {
  it.each(["tasks", "requests"])("shows claimant-scoped attention for %s", (id) => {
    const sink = entry(id);
    expect(sink.behavior).toContain("claimant actor");
    expect(sink.behavior).toContain("input-required");
    expect(sink.behavior).toContain("auth-required");
    expect(sink.connections).toContainEqual(
      expect.objectContaining({
        source: id === "tasks" ? "Tasks" : "Requests",
        target: "Actor",
        mode: "criteria",
      }),
    );
  });

  it.each(["cron", "gauge", "relay"])("keeps %s automation and flag authority explicit", (id) => {
    const scheduler = entry(id);
    expect(scheduler.behavior).toMatch(/playing|automation is enabled/);
    expect(scheduler.connections).toContainEqual(
      expect.objectContaining({
        target: "Non-region node",
        relationship: expect.stringContaining("runtime flag on Command Center"),
        mode: "effect",
      }),
    );
  });
});
