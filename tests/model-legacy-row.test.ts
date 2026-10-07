import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Node, Wire } from "../src/shared/model";
import {
  nodeFromLegacyRow,
  sheetGridFromLegacyRow,
  wireFromLegacyRow,
  type LegacyNodeRow,
  type LegacyWireRow,
} from "../src/shared/model/from-legacy-row";

const base: LegacyNodeRow = {
  canvas_name: "factory",
  node_id: "n1",
  type: "text",
  x: 1,
  y: -2,
  width: 220,
  height: 90,
  z_index: 5,
  text_content: "hello",
  color: null,
  ether_json: null,
};

describe("pure old-row conversion", () => {
  it("converts a managed seat with defaults, launch and named session", () => {
    const launch = {
      kind: "harness",
      argv: ["codex"],
      cwd: "/project",
      env: { MODE: "test" },
      extraArgs: [],
    };
    expect(
      nodeFromLegacyRow({
        ...base,
        ether_json: JSON.stringify({
          entity: { kind: "agent", name: "local:worker" },
          terminal: {
            bindingId: "bound",
            harness: "codex",
            sessionId: "known",
            launch,
          },
        }),
      }),
    ).toEqual({
      kind: "agent",
      id: "n1",
      x: 1,
      y: -2,
      width: 220,
      height: 90,
      z: 5,
      agentKey: "local:worker",
      label: "hello",
      host: "local",
      overseer: false,
      bindingId: "bound",
      harness: "codex",
      sessionId: "known",
      onRemove: "detach",
      launch,
    });
  });
  it("retains region defaults, environment, background and false hold", () => {
    const region = {
      hold: false,
      instruction: "brief",
      defaults: { paths: { local: "/project" } },
      environment: { sealed: true, sources: [], folders: ["/project"] },
    };
    expect(
      nodeFromLegacyRow({
        ...base,
        type: "group",
        group_label: "region",
        group_background: "image.png",
        group_background_style: "repeat",
        ether_json: JSON.stringify({ region }),
      }),
    ).toMatchObject({
      kind: "region",
      label: "region",
      hold: false,
      instruction: "brief",
      defaults: region.defaults,
      environment: region.environment,
      background: "image.png",
      backgroundStyle: "repeat",
    });
  });
  it("keeps task contracts, requests names, and a sheet's exact cells without Work", () => {
    const contract = { instructions: "close with evidence", rules: [] };
    const grid = {
      columns: [{ id: "c", name: "Count" }],
      rows: [{ id: "r", cells: { c: "1\n2" } }],
    };
    const task = nodeFromLegacyRow({
      ...base,
      ether_json: JSON.stringify({
        entity: { kind: "task" },
        tasks: { name: "backlog", contract, items: [] },
      }),
    });
    expect(task).toMatchObject({ kind: "task", name: "backlog", contract });
    expect("items" in task).toBe(false);
    expect(
      nodeFromLegacyRow({
        ...base,
        ether_json: JSON.stringify({
          entity: { kind: "requests" },
          requests: { name: "inbox", items: [] },
        }),
      }),
    ).toMatchObject({ kind: "requests", name: "inbox" });
    const sheet = {
      ...base,
      ether_json: JSON.stringify({ entity: { kind: "sheet" }, sheet: grid }),
    };
    expect(nodeFromLegacyRow(sheet)).toMatchObject({ kind: "sheet" });
    expect("rows" in nodeFromLegacyRow(sheet)).toBe(false);
    expect(sheetGridFromLegacyRow(sheet)).toEqual(grid);
    expect(
      sheetGridFromLegacyRow({
        ...base,
        ether_json: JSON.stringify({ entity: { kind: "task" } }),
      }),
    ).toBeUndefined();
  });
  it("maps unrecognised kinds to notes and folds timer into cron", () => {
    expect(
      nodeFromLegacyRow({
        ...base,
        ether_json: JSON.stringify({ entity: { kind: "retired" } }),
      }),
    ).toMatchObject({ kind: "note", text: "hello" });
    expect(
      nodeFromLegacyRow({
        ...base,
        ether_json: JSON.stringify({
          entity: { kind: "timer" },
          timer: { everyMinutes: 5 },
        }),
      }),
    ).toMatchObject({ kind: "cron", expression: "*/5 * * * *" });
    expect(
      nodeFromLegacyRow({
        ...base,
        ether_json: JSON.stringify({ entity: { kind: "agent" } }),
      }),
    ).toMatchObject({ kind: "note", text: "hello" });
  });
  it("converts semantic wire ends, attenuation and sides", () => {
    expect(
      wireFromLegacyRow({
        canvas_name: "factory",
        edge_id: "w",
        from_node_id: "a",
        to_node_id: "b",
        from_side: "right",
        to_side: null,
        ether_json: '{"verb":"contributes","mask":["tasks.list"]}',
      }),
    ).toEqual({
      id: "w",
      from: "a",
      to: "b",
      fromSide: "right",
      verb: "contributes",
      mask: ["tasks.list"],
    });
  });
});

const copy = process.env.JUNTO_MODEL_INSTALLED_COPY;
it.skipIf(copy === undefined)(
  "decodes every node and wire in the coherent installed database copy",
  () => {
    // Only the caller-supplied test copy is opened, never the installed path.
    const database = new DatabaseSync(copy!, { readOnly: true });
    try {
      const oldNodes = database
        .prepare(
          `SELECT d.canvas_name,n.* FROM canvas_nodes n JOIN canvas_documents d USING(canvas_id) ORDER BY d.canvas_name,n.z_index`,
        )
        .all() as unknown as LegacyNodeRow[];
      const oldWires = database
        .prepare(
          `SELECT d.canvas_name,e.* FROM canvas_edges e JOIN canvas_documents d USING(canvas_id)`,
        )
        .all() as unknown as LegacyWireRow[];
      const nodes = oldNodes.map((row) => ({
        canvas: row.canvas_name,
        node: nodeFromLegacyRow(row),
      }));
      const wires = oldWires.map((row) => ({
        canvas: row.canvas_name,
        wire: wireFromLegacyRow(row),
      }));
      expect(nodes.length).toBeGreaterThan(0);
      expect(wires.length).toBeGreaterThan(0);
      expect(nodes.every(({ node }) => Schema.is(Node)(node))).toBe(true);
      expect(wires.every(({ wire }) => Schema.is(Wire)(wire))).toBe(true);
      const identities = new Set(
        nodes.map(({ canvas, node }) => JSON.stringify([canvas, node.id])),
      );
      expect(identities.size).toBe(oldNodes.length);
      for (const { canvas, wire } of wires) {
        expect(identities.has(JSON.stringify([canvas, wire.from]))).toBe(true);
        expect(identities.has(JSON.stringify([canvas, wire.to]))).toBe(true);
      }
      console.log(
        JSON.stringify({
          objects: nodes.length,
          wires: wires.length,
          seats: nodes.filter((n) => n.node.kind === "agent").length,
          regions: nodes.filter((n) => n.node.kind === "region").length,
        }),
      );
    } finally {
      database.close();
    }
  },
);
