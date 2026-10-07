import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CanvasName, Node, NODE_KINDS, SheetGrid, type NodeKind, type Wire } from "@shared/model";
import { withSqlRead } from "../state/sql-read";
import { KIND_TABLES } from "./state-schema";
import { nodeFromRow, nodeToRow, wireFromRow, wireToRow, type SqlValues } from "./rows";

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  operation:Schema.String,message:Schema.String,cause:Schema.Unknown,
}) {}
export const modelError = (operation: string, cause: unknown) =>
  cause instanceof ModelError ? cause : new ModelError({operation,message:cause instanceof Error ? cause.message : String(cause),cause});
const failure = (operation: string) => Effect.mapError((cause:unknown)=>modelError(operation,cause));
const identifiers = Object.entries(KIND_TABLES);

export class ModelRecords extends Context.Service<ModelRecords>()("@junto/ModelRecords", {
  make: Effect.gen(function* () {
    const sql=yield* SqlClient.SqlClient;
    const parse = <T>(operation:string, fn:()=>T) => Effect.try({try:fn,catch:(cause)=>modelError(operation,cause)});
    const getCanvas = Effect.fn("ModelRecords.getCanvas")((canvas:string)=>sql<{seq:number;canvas_id:string}>`
      SELECT seq,canvas_id FROM canvases WHERE canvas_name=${canvas}`.pipe(Effect.map(rows=>rows[0]),failure("getCanvas")));
    const listCanvases = Effect.fn("ModelRecords.listCanvases")(function* () {
      const rows=yield* sql<{canvas_name:string}>`SELECT canvas_name FROM canvases ORDER BY canvas_name`;
      return yield* parse("listCanvases",()=>rows.map(row=>Schema.decodeUnknownSync(CanvasName)(row.canvas_name)));
    },failure("listCanvases"));
    const kindOf = Effect.fn("ModelRecords.kindOf")(function* (canvas:string,id:string) {
      const rows=yield* sql.unsafe<{kind:NodeKind}>(identifiers.map(([kind,table])=>
        `SELECT '${kind}' AS kind FROM ${table} WHERE canvas_name=? AND id=?`).join(" UNION ALL "),identifiers.flatMap(()=>[canvas,id]));
      if(rows.length>1) return yield* new ModelError({operation:"kindOf",message:"object identity occurs in multiple kind tables",cause:{canvas,id}});
      return rows[0]?.kind;
    },failure("kindOf"));
    const getNode = Effect.fn("ModelRecords.getNode")(function* (canvas:string,id:string) {
      const kind=yield* kindOf(canvas,id);
      if(kind===undefined) return undefined;
      const rows=yield* sql.unsafe<Record<string,unknown>>(`SELECT * FROM ${KIND_TABLES[kind]} WHERE canvas_name=? AND id=?`,[canvas,id]);
      return yield* parse("getNode",()=>nodeFromRow(kind,rows[0]!));
    },failure("getNode"));
    const listNodes = Effect.fn("ModelRecords.listNodes")(function* (canvas:string,kind?:NodeKind) {
      const nodes:Node[]=[];
      for(const selected of kind===undefined?NODE_KINDS:[kind]) {
        const rows=yield* sql.unsafe<Record<string,unknown>>(`SELECT * FROM ${KIND_TABLES[selected]} WHERE canvas_name=? ORDER BY z_index,id`,[canvas]);
        nodes.push(...yield* parse("listNodes",()=>rows.map(row=>nodeFromRow(selected,row))));
      }
      return nodes.sort((a,b)=>a.z-b.z || a.id.localeCompare(b.id));
    },failure("listNodes"));
    const getWire = Effect.fn("ModelRecords.getWire")(function* (canvas:string,id:string) {
      const rows=yield* sql`SELECT * FROM wires WHERE canvas_name=${canvas} AND id=${id}`;
      return rows[0]===undefined?undefined:yield* parse("getWire",()=>wireFromRow(rows[0]!));
    },failure("getWire"));
    const listWires = Effect.fn("ModelRecords.listWires")(function* (canvas:string) {
      const rows=yield* sql`SELECT * FROM wires WHERE canvas_name=${canvas} ORDER BY z_index,id`;
      return yield* parse("listWires",()=>rows.map(wireFromRow));
    },failure("listWires"));
    const insert = (table:string,row:SqlValues) => {
      const columns=Object.keys(row);
      return sql.unsafe(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`,Object.values(row));
    };
    const insertNode = Effect.fn("ModelRecords.insertNode")((canvas:string,node:Node)=>{
      const at=new Date().toISOString();
      return insert(KIND_TABLES[node.kind],{...nodeToRow(canvas,node),created_at:at,updated_at:at}).pipe(Effect.asVoid,failure("insertNode"));
    });
    const updateNode = Effect.fn("ModelRecords.updateNode")((canvas:string,node:Node)=>{
      const {canvas_name,id,...row}=nodeToRow(canvas,node);
      const values={...row,updated_at:new Date().toISOString()};
      return sql.unsafe(`UPDATE ${KIND_TABLES[node.kind]} SET ${Object.keys(values).map(column=>`${column}=?`).join(",")} WHERE canvas_name=? AND id=?`,[...Object.values(values),canvas_name,id]).pipe(Effect.asVoid,failure("updateNode"));
    });
    const insertWire = Effect.fn("ModelRecords.insertWire")((canvas:string,wire:Wire)=>{
      const at=new Date().toISOString();
      return insert("wires",{...wireToRow(canvas,wire),z_index:0,created_at:at,updated_at:at}).pipe(Effect.asVoid,failure("insertWire"));
    });
    const updateWire = Effect.fn("ModelRecords.updateWire")((canvas:string,wire:Wire)=>{
      const {canvas_name,id,...row}=wireToRow(canvas,wire);
      const values={...row,updated_at:new Date().toISOString()};
      return sql.unsafe(`UPDATE wires SET ${Object.keys(values).map(column=>`${column}=?`).join(",")} WHERE canvas_name=? AND id=?`,[...Object.values(values),canvas_name,id]).pipe(Effect.asVoid,failure("updateWire"));
    });
    const removeWire = Effect.fn("ModelRecords.removeWire")((canvas:string,id:string)=>
      sql`DELETE FROM wires WHERE canvas_name=${canvas} AND id=${id}`.pipe(Effect.asVoid,failure("removeWire")));
    const removeNode = Effect.fn("ModelRecords.removeNode")((canvas:string,node:Node)=>
      sql.unsafe(`DELETE FROM ${KIND_TABLES[node.kind]} WHERE canvas_name=? AND id=?`,[canvas,node.id]).pipe(Effect.asVoid,failure("removeNode")));
    const incidentWires = Effect.fn("ModelRecords.incidentWires")(function* (canvas:string,id:string) {
      const rows=yield* sql`SELECT * FROM wires WHERE canvas_name=${canvas} AND (from_id=${id} OR to_id=${id}) ORDER BY id`;
      return yield* parse("incidentWires",()=>rows.map(wireFromRow));
    },failure("incidentWires"));
    const readSheet = Effect.fn("ModelRecords.readSheet")(function* (canvas:string,id:string) {
      const rows=yield* sql<{columns_json:string;rows_json:string}>`SELECT columns_json,rows_json FROM sheet_grids WHERE canvas_name=${canvas} AND id=${id}`;
      if(!rows[0]) return undefined;
      return yield* parse("readSheet",()=>Schema.decodeUnknownSync(SheetGrid)({columns:JSON.parse(rows[0]!.columns_json),rows:JSON.parse(rows[0]!.rows_json)}));
    },failure("readSheet"));
    const writeSheet = Effect.fn("ModelRecords.writeSheet")((canvas:string,id:string,grid:SheetGrid)=>
      sql`INSERT INTO sheet_grids(canvas_name,id,columns_json,rows_json,updated_at)
        VALUES (${canvas},${id},${JSON.stringify(grid.columns)},${JSON.stringify(grid.rows)},${new Date().toISOString()})
        ON CONFLICT(canvas_name,id) DO UPDATE SET columns_json=excluded.columns_json,rows_json=excluded.rows_json,updated_at=excluded.updated_at`
        .pipe(Effect.asVoid,failure("writeSheet")));
    const createCanvas = Effect.fn("ModelRecords.createCanvas")((canvas:string,id:string)=>{
      const at=new Date().toISOString();
      return sql`INSERT INTO canvases(canvas_name,canvas_id,created_at,updated_at) VALUES (${canvas},${id},${at},${at})`.pipe(Effect.asVoid,failure("createCanvas"));
    });
    const advanceSeq = Effect.fn("ModelRecords.advanceSeq")(function* (canvas:string) {
      const rows=yield* sql<{seq:number}>`UPDATE canvases SET seq=seq+1,updated_at=${new Date().toISOString()} WHERE canvas_name=${canvas} RETURNING seq`;
      if(rows[0]===undefined) return yield* new ModelError({operation:"advanceSeq",message:"canvas does not exist",cause:canvas});
      return rows[0].seq;
    },failure("advanceSeq"));
    const removeCanvas = Effect.fn("ModelRecords.removeCanvas")(function* (canvas:string) {
      yield* sql`DELETE FROM wires WHERE canvas_name=${canvas}`;
      for(const table of Object.values(KIND_TABLES)) yield* sql.unsafe(`DELETE FROM ${table} WHERE canvas_name=?`,[canvas]);
      yield* sql`DELETE FROM canvases WHERE canvas_name=${canvas}`;
    },failure("removeCanvas"));
    const renameCanvas = Effect.fn("ModelRecords.renameCanvas")((canvas:string,to:string)=>
      sql`UPDATE canvases SET canvas_name=${to},updated_at=${new Date().toISOString()} WHERE canvas_name=${canvas}`.pipe(Effect.asVoid,failure("renameCanvas")));
    return {getCanvas,listCanvases,kindOf,
      getNode:(canvas:string,id:string)=>withSqlRead(sql,getNode(canvas,id)).pipe(failure("getNode")),
      listNodes:(canvas:string,kind?:NodeKind)=>withSqlRead(sql,listNodes(canvas,kind)).pipe(failure("listNodes")),
      getWire,listWires,incidentWires,readSheet,writeSheet,insertNode,updateNode,insertWire,updateWire,removeWire,removeNode,createCanvas,advanceSeq,removeCanvas,renameCanvas};
  }),
}) {
  static readonly layer=Layer.effect(this,this.make);
}
