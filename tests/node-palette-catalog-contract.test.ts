import { describe, expect, it } from "vitest";
import {
  DEFAULT_NODE_CATALOG_ENTRIES,
  NODE_CATALOG_CATEGORY_ACCENT,
  NO_WIRES_COPY,
  catalogWireLines,
} from "../src/renderer/components/node-palette/NodeCatalogGrid";

const entry = (id: string) => {
  const match = DEFAULT_NODE_CATALOG_ENTRIES.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`missing catalog entry: ${id}`);
  return match;
};

const lineFor = (id: string, family: "access" | "watch" | "effect") =>
  catalogWireLines(id).find((line) => line.family === family);

describe("node palette catalog contract", () => {
  it("assigns one non-blocker accent per node category", () => {
    expect(NODE_CATALOG_CATEGORY_ACCENT).toEqual({
      shell: "text-cyan",
      sinks: "text-amber",
      schedule: "text-violet",
      canvas: "text-indigo",
    });
    expect(Object.values(NODE_CATALOG_CATEGORY_ACCENT)).not.toContain("text-crimson");
  });

  it("derives the three tasks wire lines from the task contract", () => {
    expect(entry("tasks").category).toBe("sinks");
    const lines = catalogWireLines("tasks");
    expect(lines.map((line) => line.family)).toEqual(["access", "watch", "effect"]);
    expect(lineFor("tasks", "access")?.text).toContain("Agents can:");
    expect(lineFor("tasks", "access")?.text).toContain("Claim tasks");
    expect(lineFor("tasks", "watch")?.text).toContain("A relay can watch:");
    expect(lineFor("tasks", "watch")?.text).toContain("A task completes");
    expect(lineFor("tasks", "effect")?.text).toContain("Cron and relay can:");
    expect(lineFor("tasks", "effect")?.text).toContain("Add a task");
  });

  it("gives relay a humanized access line and a watch line, no effect line", () => {
    const lines = catalogWireLines("relay");
    expect(lines.map((line) => line.family)).toEqual(["access", "watch"]);
    expect(lineFor("relay", "access")?.text).toBe("Agents can: Fire the relay");
    expect(lineFor("relay", "watch")?.text).toBe("A relay can watch: Fired");
  });

  it("derives board wires from board events and inputs", () => {
    const lines = catalogWireLines("board");
    expect(lines.map((line) => line.family)).toEqual(["access", "watch", "effect"]);
    expect(lineFor("board", "watch")?.text).toContain("A post lands");
    expect(lineFor("board", "watch")?.text).toContain("A topic is created");
    expect(lineFor("board", "effect")?.text).toBe(
      "Cron and relay can: Create a topic, Post to a topic, Set a flag",
    );
  });

  it.each(["note", "label", "region"])("keeps %s off the wire grammar as map furniture", (id) => {
    expect(catalogWireLines(id)).toEqual([]);
    expect(NO_WIRES_COPY[id]).toBe("No wires — sits on the map.");
  });

  it.each(["terminal", "herdr"])("keeps %s hands-on with no wires", (id) => {
    expect(catalogWireLines(id)).toEqual([]);
    expect(NO_WIRES_COPY[id]).toBe("No wires — open it and work by hand.");
  });
});
