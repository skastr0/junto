import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNestedCanvas,
  buildNestedCanvasFixture,
  loadFactoryShapeCanvas,
  NESTED_CANVAS_PRESETS,
  type NestedCanvasPresetName,
} from "../e2e/harness/nested-canvas-fixture";
import { asNodeId, asCanvasName, canvasFromOpened, Node, Wire, type Region, regionStack as modelRegionStack } from "../src/shared/model";
import type { ModelFixture } from "../e2e/harness/model";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";

const isGroup = (node: Node): node is Region => node.kind === "region";

const members = (doc: ModelFixture) => doc.nodes.filter((node) => !isGroup(node));
/** Region membership is the model's, so the fixture is read as the canvas it seeds. */
const stacksOf = (doc: ModelFixture) => {
  const canvas = canvasFromOpened({ canvas: asCanvasName("nested"), seq: 0, nodes: doc.nodes, wires: doc.wires });
  return (id: string) => modelRegionStack(canvas, asNodeId(id));
};

describe("nested-region stress canvas", () => {
  it("builds the same rows from the same seed, and a different one from another", () => {
    expect(JSON.stringify(buildNestedCanvas())).toBe(JSON.stringify(buildNestedCanvas()));
    expect(JSON.stringify(buildNestedCanvas({ seed: 9 }))).not.toBe(JSON.stringify(buildNestedCanvas()));
    const source = readFileSync(new URL("../e2e/harness/nested-canvas-fixture.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date/);
  });

  it.each(Object.keys(NESTED_CANVAS_PRESETS) as NestedCanvasPresetName[])(
    "%s decodes whole: no wire or node is scrubbed away",
    (preset) => {
      const { model: doc } = buildNestedCanvasFixture(preset);
      const strict = { onExcessProperty: "error" } as const;
      expect(Schema.decodeUnknownSync(Schema.Array(Node), strict)(doc.nodes)).toHaveLength(doc.nodes.length);
      expect(Schema.decodeUnknownSync(Schema.Array(Wire), strict)(doc.wires)).toHaveLength(doc.wires.length);
    },
  );

  it("nests 4 to 6 levels with 40+ labelled regions and 150-300 members", () => {
    for (const preset of ["nested", "deep", "max"] as const) {
      const { model: doc, stats } = buildNestedCanvasFixture(preset);
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
    const { model: doc } = buildNestedCanvasFixture("nested");
    const stack = stacksOf(doc);
    for (const group of doc.nodes.filter(isGroup)) {
      const level = group.id.split("-").length - 2;
      expect(stack(group.id)).toHaveLength(level);
    }
    const loose = members(doc).filter((node) => stack(node.id).length === 0);
    expect(loose.map((node) => node.id)).toEqual(
      loose.filter((node) => node.id.startsWith("note-")).map((node) => node.id),
    );
    expect(loose.length).toBe(NESTED_CANVAS_PRESETS.nested.looseNotes);
  });

  it("wires within regions and across region boundaries", () => {
    const { model: doc } = buildNestedCanvasFixture("nested");
    const stack = stacksOf(doc);
    const innermost = (id: string) => stack(id).at(-1)?.id;
    const crossing = doc.wires.filter((edge) => innermost(edge.from) !== innermost(edge.to));
    expect(crossing.length).toBeGreaterThan(20);
    expect(doc.wires.length - crossing.length).toBeGreaterThan(100);
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
    db.exec(MODEL_STATE_SCHEMA_SQL);
    const geometry = "canvas_name,id,z_index,x,y,width,height,color,created_at,updated_at";
    const times = "'2000-01-01', '2000-01-01'";
    db.exec(`
      INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('factory', 'c1', '2000-01-01', '2000-01-01', 0);
      INSERT INTO regions (${geometry}, label, hold) VALUES
        ('factory', 'outer', 0, 0, 0, 2000, 1200, '4', ${times}, 'Secret outer', 0),
        ('factory', 'inner', 1, 100, 100, 900, 600, NULL, ${times}, 'Secret inner', 0);
      INSERT INTO seats (${geometry}, agent_key,label,host,binding_id,harness,on_remove,overseer) VALUES
        ('factory', 'a1', 2, 150, 200, 300, 96, '2', ${times}, 'local:x', 'secret seat', 'local', 'x', 'codex', 'detach', 0),
        ('factory', 'a2', 3, 500, 200, 240, 96, NULL, ${times}, 'local:y', 'secret seat', 'local', 'y', 'codex', 'detach', 0);
      INSERT INTO notes (${geometry},text) VALUES
        ('factory', 'n1', 4, 1200, 200, 300, 400, NULL, ${times}, 'secret note');
      INSERT INTO pages (${geometry},url,profile,on_remove) VALUES
        ('factory', 'p1', 5, 1200, 700, 400, 300, NULL, ${times}, 'https://secret.example', 'personal', 'detach');
      INSERT INTO wires (canvas_name,id,from_id,to_id,verb,created_at,updated_at) VALUES
        ('factory', 'e1', 'a1', 'a2', 'messages', ${times}),
        ('factory', 'e2', 'a1', 'p1', 'navigates', ${times});
    `);
    db.close();
    return path;
  };

  it("keeps geometry, nesting, colours and legal wires, and reads no text", () => {
    const { model: doc, stats } = loadFactoryShapeCanvas({ dbPath: copyWith() });
    expect(stats).toMatchObject({ regions: 2, depth: 2, seats: 2, notes: 2, edges: 1 });
    expect(doc.nodes.map((node) => [node.x, node.y, node.width, node.height])).toContainEqual([1200, 200, 300, 400]);
    expect(doc.nodes.find((node) => node.id === "region-1")).toMatchObject({ color: "4", width: 2000 });
    expect(stacksOf(doc)("seat-1").map((group) => group.id)).toEqual(["region-1", "region-2"]);
    expect(JSON.stringify(doc)).not.toMatch(/secret/i);
    expect(() => Schema.decodeUnknownSync(Schema.Array(Node), { onExcessProperty: "error" })(doc.nodes)).not.toThrow();
    expect(doc.nodes.find((node) => node.id === "seat-1")?.width).toBe(300);
  });

  it("refuses the live database under ~/.junto", () => {
    expect(() => loadFactoryShapeCanvas({ dbPath: join(homedir(), ".junto", "state", "junto.db") })).toThrow(/COPY/);
  });
});
