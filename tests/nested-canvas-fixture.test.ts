import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNestedCanvas,
  buildNestedCanvasFixture,
  loadFactoryShapeCanvas,
  NESTED_CANVAS_PRESETS,
  type NestedCanvasPresetName,
} from "../e2e/harness/nested-canvas-fixture";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { isGroup, regionStack } from "../src/shared/graph";

const members = (doc: CanvasDoc) => doc.nodes.filter((node) => !isGroup(node));

describe("nested-region stress canvas", () => {
  it("builds the same document from the same seed, and a different one from another", () => {
    expect(JSON.stringify(buildNestedCanvas())).toBe(JSON.stringify(buildNestedCanvas()));
    expect(JSON.stringify(buildNestedCanvas({ seed: 9 }))).not.toBe(JSON.stringify(buildNestedCanvas()));
    const source = readFileSync(new URL("../e2e/harness/nested-canvas-fixture.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date/);
  });

  it.each(Object.keys(NESTED_CANVAS_PRESETS) as NestedCanvasPresetName[])(
    "%s decodes whole: no wire or node is scrubbed away",
    (preset) => {
      const { doc } = buildNestedCanvasFixture(preset);
      const decoded = decodeCanvasDoc(doc);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (Result.isFailure(decoded)) return;
      expect(decoded.success.nodes).toHaveLength(doc.nodes.length);
      expect(decoded.success.edges).toHaveLength(doc.edges.length);
    },
  );

  it("nests 4 to 6 levels with 40+ labelled regions and 150-300 members", () => {
    for (const preset of ["nested", "deep", "max"] as const) {
      const { doc, stats } = buildNestedCanvasFixture(preset);
      expect(stats.depth).toBeGreaterThanOrEqual(4);
      expect(stats.depth).toBeLessThanOrEqual(6);
      expect(stats.regions).toBeGreaterThanOrEqual(40);
      expect(members(doc).length).toBeGreaterThanOrEqual(150);
      expect(members(doc).length).toBeLessThanOrEqual(420);
      expect(stats.seats).toBeGreaterThanOrEqual(150);
      expect(stats.terminals + stats.gits).toBeGreaterThan(0);
      expect(doc.nodes.filter(isGroup).every((group) => (group.label ?? "").length > 0)).toBe(true);
      expect(new Set(doc.nodes.filter(isGroup).map((group) => group.color)).size).toBeGreaterThan(3);
    }
    expect(buildNestedCanvasFixture("deep").stats.depth).toBe(6);
  });

  it("puts every region inside its parent and every region member inside a region", () => {
    const { doc } = buildNestedCanvasFixture("nested");
    for (const group of doc.nodes.filter(isGroup)) {
      const level = group.id.split("-").length - 2;
      expect(regionStack(doc, group.id)).toHaveLength(level);
    }
    const loose = members(doc).filter((node) => regionStack(doc, node.id).length === 0);
    expect(loose.map((node) => node.id)).toEqual(
      loose.filter((node) => node.id.startsWith("note-")).map((node) => node.id),
    );
    expect(loose.length).toBe(NESTED_CANVAS_PRESETS.nested.looseNotes);
  });

  it("wires within regions and across region boundaries", () => {
    const { doc } = buildNestedCanvasFixture("nested");
    const innermost = (id: string) => regionStack(doc, id).at(-1)?.id;
    const crossing = doc.edges.filter((edge) => innermost(edge.fromNode) !== innermost(edge.toNode));
    expect(crossing.length).toBeGreaterThan(20);
    expect(doc.edges.length - crossing.length).toBeGreaterThan(100);
  });

  it("addresses open signals to the canvas it is seeded as", () => {
    const fixture = buildNestedCanvasFixture("nested");
    const signals = fixture.signals("stress");
    expect(signals.length).toBe(fixture.stats.signals);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.canvasName === "stress" && signal.state === "open")).toBe(true);
  });
});

describe("real canvas shape from a database copy", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const copyWith = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "junto-shape-"));
    dirs.push(dir);
    const path = join(dir, "junto.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE canvas_documents (canvas_id TEXT, canvas_name TEXT);
      CREATE TABLE canvas_nodes (canvas_id TEXT, node_id TEXT, z_index INTEGER, type TEXT,
        x REAL, y REAL, width REAL, height REAL, color TEXT, text_content TEXT,
        group_label TEXT, ether_json TEXT);
      CREATE TABLE canvas_edges (canvas_id TEXT, edge_id TEXT, z_index INTEGER,
        from_node_id TEXT, to_node_id TEXT, ether_json TEXT);
      INSERT INTO canvas_documents VALUES ('c1', 'factory');
      INSERT INTO canvas_nodes VALUES
        ('c1', 'outer', 0, 'group', 0, 0, 2000, 1200, '4', NULL, 'Secret outer', NULL),
        ('c1', 'inner', 1, 'group', 100, 100, 900, 600, NULL, NULL, 'Secret inner', NULL),
        ('c1', 'a1', 2, 'text', 150, 200, 240, 96, '2', 'secret seat',  NULL, '{"entity":{"kind":"agent","name":"local:x"}}'),
        ('c1', 'a2', 3, 'text', 500, 200, 240, 96, NULL, 'secret seat', NULL, '{"entity":{"kind":"agent","name":"local:y"}}'),
        ('c1', 'n1', 4, 'text', 1200, 200, 300, 400, NULL, 'secret note', NULL, NULL),
        ('c1', 'p1', 5, 'link', 1200, 700, 400, 300, NULL, NULL, NULL, '{"entity":{"kind":"page"}}');
      INSERT INTO canvas_edges VALUES
        ('c1', 'e1', 0, 'a1', 'a2', '{"verb":"messages"}'),
        ('c1', 'e2', 1, 'a1', 'p1', '{"verb":"navigates"}');
    `);
    db.close();
    return path;
  };

  it("keeps geometry, nesting, colours and legal wires, and reads no text", () => {
    const { doc, stats } = loadFactoryShapeCanvas({ dbPath: copyWith() });
    expect(stats).toMatchObject({ regions: 2, depth: 2, seats: 2, notes: 2, edges: 1 });
    expect(doc.nodes.map((node) => [node.x, node.y, node.width, node.height])).toContainEqual([1200, 200, 300, 400]);
    expect(doc.nodes.find((node) => node.id === "region-1")).toMatchObject({ color: "4", width: 2000 });
    expect(regionStack(doc, "seat-1").map((group) => group.id)).toEqual(["region-1", "region-2"]);
    expect(JSON.stringify(doc)).not.toMatch(/secret/i);
    expect(Result.isSuccess(decodeCanvasDoc(doc))).toBe(true);
  });

  it("refuses the live database under ~/.junto", () => {
    expect(() => loadFactoryShapeCanvas({ dbPath: join(homedir(), ".junto", "state", "junto.db") })).toThrow(/COPY/);
  });
});
