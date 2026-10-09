import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  CanvasName,
  Node,
  NODE_KINDS,
  SheetGrid,
  type NodeKind,
  type Wire,
} from "@shared/model";
import { withSqlRead } from "../state/sql-read";
import { KIND_TABLES } from "./state-schema";
import {
  nodeFromRow,
  nodeToRow,
  wireFromRow,
  wireToRow,
  type SqlValues,
} from "./rows";

export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()(
  "ModelNotFound",
  {
    what: Schema.String,
    id: Schema.String,
  },
) {}
export class ModelRefused extends Schema.TaggedError<ModelRefused>()(
  "ModelRefused",
  {
    rule: Schema.String,
  },
) {}
export class ModelStorageError extends Schema.TaggedError<ModelStorageError>()(
  "ModelStorageError",
  {
    cause: Schema.Unknown,
  },
) {}
export type ModelError = ModelNotFound | ModelRefused | ModelStorageError;
export const modelError = (_operation: string, cause: unknown): ModelError =>
  cause instanceof ModelNotFound ||
  cause instanceof ModelRefused ||
  cause instanceof ModelStorageError
    ? cause
    : new ModelStorageError({ cause });
const failure = (operation: string) =>
  Effect.mapError((cause: unknown) => modelError(operation, cause));
const identifiers = Object.entries(KIND_TABLES);
const CanvasHeaderRow = Schema.Struct({
  seq: Schema.Int,
  canvas_id: Schema.String,
});
const CanvasNameRow = Schema.Struct({ canvas_name: CanvasName });
const KindRow = Schema.Struct({ kind: Schema.Literals(NODE_KINDS) });
const SheetStorageRow = Schema.Struct({
  columns_json: Schema.String,
  rows_json: Schema.String,
});

export class ModelRecords extends Context.Service<ModelRecords>()(
  "@junto/ModelRecords",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const parse = <T>(operation: string, fn: () => T) =>
        Effect.try({ try: fn, catch: (cause) => modelError(operation, cause) });
      const seatHosts = SqlSchema.findAll({
        Request: Schema.String,
        Result: Schema.Struct({ host_id: Schema.String }),
        execute: (host) => sql`SELECT machine_name AS host_id FROM machine_configuration
          WHERE singleton=1 AND machine_name=${host}
          UNION ALL SELECT machine_name AS host_id FROM machine_peers WHERE retired_at IS NULL AND machine_name=${host}`,
      });
      const requireSeatHost = Effect.fn("ModelRecords.requireSeatHost")(function* (host: string) {
        if ((yield* seatHosts(host)).length === 0)
          return yield* new ModelRefused({ rule: `Seat has unresolved host "${host}"; configure its installation.` });
      }, failure("requireSeatHost"));
      const canvasHeaders = SqlSchema.findAll({
        Request: Schema.String,
        Result: CanvasHeaderRow,
        execute: (canvas) =>
          sql`SELECT seq,canvas_id FROM canvases WHERE canvas_name=${canvas}`,
      });
      const getCanvas = Effect.fn("ModelRecords.getCanvas")((canvas: string) =>
        canvasHeaders(canvas).pipe(
          Effect.map((rows) => rows[0]),
          failure("getCanvas"),
        ),
      );
      const canvasEditors = SqlSchema.findAll({
        Request: Schema.String,
        Result: Schema.Struct({ editor_installation_id: Schema.NullOr(Schema.String) }),
        execute: (canvas) =>
          sql`SELECT editor_installation_id FROM canvases WHERE canvas_name=${canvas}`,
      });
      /** The installation id of the one machine that may change a canvas. */
      const canvasEditor = Effect.fn("ModelRecords.canvasEditor")((canvas: string) =>
        canvasEditors(canvas).pipe(
          Effect.map((rows) => rows[0]?.editor_installation_id ?? undefined),
          failure("canvasEditor"),
        ),
      );
      const canvasEdits = SqlSchema.findAll({
        Request: Schema.String,
        Result: Schema.Struct({ edits: Schema.Number }),
        execute: (canvas) =>
          sql`SELECT COALESCE(
              editor_installation_id IS NULL
              OR editor_installation_id = (SELECT installation_id FROM installation WHERE singleton = 1),
              0
            ) AS edits
            FROM canvases WHERE canvas_name=${canvas}`,
      });
      /**
       * Does this machine edit that canvas. A canvas held as a copy is edited
       * on another machine; a canvas that does not exist is no copy.
       */
      const editsCanvas = Effect.fn("ModelRecords.editsCanvas")((canvas: string) =>
        canvasEdits(canvas).pipe(
          Effect.map((rows) => rows[0] === undefined || rows[0].edits === 1),
          failure("editsCanvas"),
        ),
      );
      const canvasNames = SqlSchema.findAll({
        Request: Schema.Void,
        Result: CanvasNameRow,
        execute: () =>
          sql`SELECT canvas_name FROM canvases ORDER BY canvas_name`,
      });
      const listCanvases = Effect.fn("ModelRecords.listCanvases")(function* () {
        const rows = yield* canvasNames(undefined);
        return rows.map((row) => row.canvas_name);
      }, failure("listCanvases"));
      const listCanvasSummaries = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ name: CanvasName, modifiedAt: Schema.String }),
        execute: () => sql`SELECT canvas_name AS name,updated_at AS modifiedAt FROM canvases ORDER BY canvas_name`,
      });
      const kindOf = Effect.fn("ModelRecords.kindOf")(function* (
        canvas: string,
        id: string,
      ) {
        const rows = yield* sql.unsafe<{ kind: NodeKind }>(
          identifiers
            .map(
              ([kind, table]) =>
                `SELECT '${kind}' AS kind FROM ${table} WHERE canvas_name=? AND id=?`,
            )
            .join(" UNION ALL "),
          identifiers.flatMap(() => [canvas, id]),
        );
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Array(KindRow),
        )(rows);
        if (decoded.length > 1)
          return yield* new ModelStorageError({
            cause: `object ${canvas}/${id} occurs in multiple kind tables`,
          });
        return decoded[0]?.kind;
      }, failure("kindOf"));
      const getNode = Effect.fn("ModelRecords.getNode")(function* (
        canvas: string,
        id: string,
      ) {
        const kind = yield* kindOf(canvas, id);
        if (kind === undefined) return undefined;
        const rows = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT * FROM ${KIND_TABLES[kind]} WHERE canvas_name=? AND id=?`,
          [canvas, id],
        );
        return yield* parse("getNode", () => nodeFromRow(kind, rows[0]!));
      }, failure("getNode"));
      const listNodes = Effect.fn("ModelRecords.listNodes")(function* (
        canvas: string,
        kind?: NodeKind,
      ) {
        const nodes: Node[] = [];
        for (const selected of kind === undefined ? NODE_KINDS : [kind]) {
          const rows = yield* sql.unsafe<Record<string, unknown>>(
            `SELECT * FROM ${KIND_TABLES[selected]} WHERE canvas_name=? ORDER BY z_index,id`,
            [canvas],
          );
          nodes.push(
            ...(yield* parse("listNodes", () =>
              rows.map((row) => nodeFromRow(selected, row)),
            )),
          );
        }
        return nodes.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
      }, failure("listNodes"));
      const getWire = Effect.fn("ModelRecords.getWire")(function* (
        canvas: string,
        id: string,
      ) {
        const rows =
          yield* sql`SELECT * FROM wires WHERE canvas_name=${canvas} AND id=${id}`;
        return rows[0] === undefined
          ? undefined
          : yield* parse("getWire", () => wireFromRow(rows[0]!));
      }, failure("getWire"));
      const listWires = Effect.fn("ModelRecords.listWires")(function* (
        canvas: string,
      ) {
        const rows =
          yield* sql`SELECT * FROM wires WHERE canvas_name=${canvas} ORDER BY id`;
        return yield* parse("listWires", () => rows.map(wireFromRow));
      }, failure("listWires"));
      const insert = (table: string, row: SqlValues) => {
        const columns = Object.keys(row);
        return sql.unsafe(
          `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          Object.values(row),
        );
      };
      const insertNode = Effect.fn("ModelRecords.insertNode")((
        canvas: string,
        node: Node,
      ) => {
        const at = new Date().toISOString();
        return insert(KIND_TABLES[node.kind], {
          ...nodeToRow(canvas, node),
          created_at: at,
          updated_at: at,
        }).pipe(Effect.asVoid, failure("insertNode"));
      });
      const updateNode = Effect.fn("ModelRecords.updateNode")((
        canvas: string,
        node: Node,
      ) => {
        const { canvas_name, id, ...row } = nodeToRow(canvas, node);
        const values = { ...row, updated_at: new Date().toISOString() };
        return sql
          .unsafe(
            `UPDATE ${KIND_TABLES[node.kind]} SET ${Object.keys(values)
              .map((column) => `${column}=?`)
              .join(",")} WHERE canvas_name=? AND id=?`,
            [...Object.values(values), canvas_name, id],
          )
          .pipe(Effect.asVoid, failure("updateNode"));
      });
      const insertWire = Effect.fn("ModelRecords.insertWire")((
        canvas: string,
        wire: Wire,
      ) => {
        const at = new Date().toISOString();
        return insert("wires", {
          ...wireToRow(canvas, wire),
          created_at: at,
          updated_at: at,
        }).pipe(Effect.asVoid, failure("insertWire"));
      });
      const updateWire = Effect.fn("ModelRecords.updateWire")((
        canvas: string,
        wire: Wire,
      ) => {
        const { canvas_name, id, ...row } = wireToRow(canvas, wire);
        const values = { ...row, updated_at: new Date().toISOString() };
        return sql
          .unsafe(
            `UPDATE wires SET ${Object.keys(values)
              .map((column) => `${column}=?`)
              .join(",")} WHERE canvas_name=? AND id=?`,
            [...Object.values(values), canvas_name, id],
          )
          .pipe(Effect.asVoid, failure("updateWire"));
      });
      const removeWire = Effect.fn("ModelRecords.removeWire")(
        (canvas: string, id: string) =>
          sql`DELETE FROM wires WHERE canvas_name=${canvas} AND id=${id}`.pipe(
            Effect.asVoid,
            failure("removeWire"),
          ),
      );
      const removeNode = Effect.fn("ModelRecords.removeNode")(
        (canvas: string, node: Node) =>
          sql
            .unsafe(
              `DELETE FROM ${KIND_TABLES[node.kind]} WHERE canvas_name=? AND id=?`,
              [canvas, node.id],
            )
            .pipe(Effect.asVoid, failure("removeNode")),
      );
      const incidentWires = Effect.fn("ModelRecords.incidentWires")(function* (
        canvas: string,
        id: string,
      ) {
        const rows =
          yield* sql`SELECT * FROM wires WHERE canvas_name=${canvas} AND (from_id=${id} OR to_id=${id}) ORDER BY id`;
        return yield* parse("incidentWires", () => rows.map(wireFromRow));
      }, failure("incidentWires"));
      const readSheet = Effect.fn("ModelRecords.readSheet")(function* (
        canvas: string,
        id: string,
      ) {
        const result =
          yield* sql`SELECT columns_json,rows_json FROM sheet_grids WHERE canvas_name=${canvas} AND id=${id}`;
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(SheetStorageRow),
        )(result);
        if (!rows[0]) return undefined;
        return yield* parse("readSheet", () =>
          Schema.decodeUnknownSync(SheetGrid)({
            columns: JSON.parse(rows[0]!.columns_json),
            rows: JSON.parse(rows[0]!.rows_json),
          }),
        );
      }, failure("readSheet"));
      const writeSheet = Effect.fn("ModelRecords.writeSheet")(
        (canvas: string, id: string, grid: SheetGrid) =>
          sql`INSERT INTO sheet_grids(canvas_name,id,columns_json,rows_json,updated_at)
        VALUES (${canvas},${id},${JSON.stringify(grid.columns)},${JSON.stringify(grid.rows)},${new Date().toISOString()})
        ON CONFLICT(canvas_name,id) DO UPDATE SET columns_json=excluded.columns_json,rows_json=excluded.rows_json,updated_at=excluded.updated_at`.pipe(
            Effect.asVoid,
            failure("writeSheet"),
          ),
      );
      const createCanvas = Effect.fn("ModelRecords.createCanvas")((
        canvas: string,
        id: string,
      ) => {
        const at = new Date().toISOString();
        return sql`INSERT INTO canvases(canvas_name,canvas_id,created_at,updated_at,editor_installation_id)
          VALUES (${canvas},${id},${at},${at},(SELECT installation_id FROM installation WHERE singleton = 1))`.pipe(
          Effect.asVoid,
          failure("createCanvas"),
        );
      });
      const advanceSeq = Effect.fn("ModelRecords.advanceSeq")(function* (
        canvas: string,
      ) {
        const rows = yield* sql<{
          seq: number;
        }>`UPDATE canvases SET seq=seq+1,updated_at=${new Date().toISOString()} WHERE canvas_name=${canvas} RETURNING seq`;
        if (rows[0] === undefined)
          return yield* new ModelNotFound({ what: "canvas", id: canvas });
        return rows[0].seq;
      }, failure("advanceSeq"));
      /**
       * Put a copy of a canvas in place of whatever this machine holds of it:
       * every node and wire goes, the copy's come in, and the canvas takes
       * the copy's count and editing machine. The caller owns the transaction.
       */
      const replaceCanvas = Effect.fn("ModelRecords.replaceCanvas")(function* (input: {
        readonly canvas: string;
        readonly canvasId: string;
        readonly seq: number;
        readonly editor: string;
        readonly nodes: ReadonlyArray<Node>;
        readonly wires: ReadonlyArray<Wire>;
      }) {
        const at = new Date().toISOString();
        yield* sql`DELETE FROM wires WHERE canvas_name=${input.canvas}`;
        for (const table of Object.values(KIND_TABLES))
          yield* sql.unsafe(`DELETE FROM ${table} WHERE canvas_name=?`, [input.canvas]);
        yield* sql`INSERT INTO canvases(canvas_name,canvas_id,created_at,updated_at,seq,editor_installation_id)
          VALUES (${input.canvas},${input.canvasId},${at},${at},${input.seq},${input.editor})
          ON CONFLICT(canvas_name) DO UPDATE SET seq=excluded.seq, updated_at=excluded.updated_at,
            canvas_id=excluded.canvas_id, editor_installation_id=excluded.editor_installation_id`;
        for (const node of input.nodes)
          yield* insert(KIND_TABLES[node.kind], { ...nodeToRow(input.canvas, node), created_at: at, updated_at: at });
        for (const wire of input.wires)
          yield* insert("wires", { ...wireToRow(input.canvas, wire), created_at: at, updated_at: at });
      }, failure("replaceCanvas"));
      const thisInstallation = Effect.fn("ModelRecords.thisInstallation")(() =>
        sql<{ installation_id: string }>`SELECT installation_id FROM installation WHERE singleton = 1`.pipe(
          Effect.map((rows) => rows[0]?.installation_id),
          failure("thisInstallation"),
        ),
      );
      const removeCanvas = Effect.fn("ModelRecords.removeCanvas")(function* (
        canvas: string,
      ) {
        yield* sql`DELETE FROM wires WHERE canvas_name=${canvas}`;
        for (const table of Object.values(KIND_TABLES))
          yield* sql.unsafe(`DELETE FROM ${table} WHERE canvas_name=?`, [
            canvas,
          ]);
        yield* sql`DELETE FROM canvases WHERE canvas_name=${canvas}`;
      }, failure("removeCanvas"));
      return {
        requireSeatHost,
        getCanvas,
        canvasEditor,
        editsCanvas,
        listCanvases,
        listCanvasSummaries: () => listCanvasSummaries(undefined).pipe(failure("listCanvasSummaries")),
        kindOf,
        getNode: (canvas: string, id: string) =>
          withSqlRead(sql, getNode(canvas, id)).pipe(failure("getNode")),
        listNodes: (canvas: string, kind?: NodeKind) =>
          withSqlRead(sql, listNodes(canvas, kind)).pipe(failure("listNodes")),
        getWire,
        listWires,
        incidentWires,
        readSheet,
        writeSheet,
        insertNode,
        updateNode,
        insertWire,
        updateWire,
        removeWire,
        removeNode,
        createCanvas,
        replaceCanvas,
        thisInstallation,
        advanceSeq,
        removeCanvas,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
