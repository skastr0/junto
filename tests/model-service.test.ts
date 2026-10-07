import { DatabaseSync } from "node:sqlite";
import { Effect, Fiber, Schema, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Changed, Command, type SheetChanged } from "../src/shared/model";
import { ModelService } from "../src/main/junto/model/service";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { installSqlCommitCallbacks } from "../src/main/junto/state/sql-commit";

const at="2026-10-07T00:00:00Z";
const node=(id:string,kind="note",fields:object={})=>({id,kind,x:0,y:0,width:200,height:90,z:0,...(kind==="note"?{text:id}:{}),...fields});
const seat=node("seat","agent",{name:"local:seat",label:"Seat",host:"local",overseer:false,bindingId:"binding",harness:"codex",onRemove:"detach"});
const decode=Schema.decodeUnknownSync(Command);
const run=(test:(model:ModelService["Service"],sql:SqlClient.SqlClient,db:DatabaseSync)=>Effect.Effect<void,unknown>)=>Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const db=yield* Effect.acquireRelease(Effect.sync(()=>new DatabaseSync(":memory:")),db=>Effect.sync(()=>db.close()));
    db.exec(MODEL_STATE_SCHEMA_SQL);
    db.prepare("INSERT INTO canvases(canvas_name,canvas_id,created_at,updated_at) VALUES ('factory','c',?,?)").run(at,at);
    const sql=yield* makeSqliteClient(db);
    installSqlCommitCallbacks(sql);
    yield* Effect.gen(function* () {
      const model=yield* ModelService;
      yield* test(model,sql,db);
    }).pipe(Effect.provide(ModelService.layer),Effect.provideService(SqlClient.SqlClient,sql));
  })).pipe(Effect.provide(Reactivity.layer)),
);

it("changes only addressed rows and publishes one event after commit, including its sender",()=>run((model,_sql,db)=>Effect.gen(function* () {
  const seen:Changed[]=[];
  const subscriber=yield* model.changes.pipe(Stream.runForEach(event=>Effect.sync(()=>{
    expect(db.isTransaction).toBe(false);seen.push(event);
  })),Effect.forkChild);
  yield* Effect.yieldNow;
  expect(yield* model.command(decode({_tag:"Add",canvas:"factory",nodes:[node("a"),node("b")],wires:[]}),"operator")).toEqual({seq:1});
  yield* Effect.yieldNow;
  const unchanged=db.prepare("SELECT * FROM notes WHERE id='b'").get();
  const reply=yield* model.command(decode({_tag:"Edit",canvas:"factory",id:"a",change:{kind:"note",text:"changed"}}),"operator");
  yield* Effect.yieldNow;
  expect(reply.seq).toBe(2);
  expect(seen.map(event=>event.seq)).toEqual([1,2]);
  expect(seen[1]!.nodes.map(node=>node.id)).toEqual(["a"]);
  expect(db.prepare("SELECT * FROM notes WHERE id='b'").get()).toEqual(unchanged);
  const opened=yield* model.open("factory");
  expect(opened.seq).toBe(2);
  expect(opened.nodes.find(node=>node.id==="a")).toMatchObject({kind:"note",text:"changed"});
  expect("messages" in opened).toBe(false);
  yield* Fiber.interrupt(subscriber);
})));

it("emits nothing and keeps seq and rows intact after a failed command or outer rollback",()=>run((model,sql)=>Effect.gen(function* () {
  const seen:Changed[]=[];
  const subscriber=yield* model.changes.pipe(Stream.runForEach(event=>Effect.sync(()=>{seen.push(event);})),Effect.forkChild);
  yield* Effect.yieldNow;
  const failed=yield* model.command(decode({_tag:"Add",canvas:"factory",nodes:[node("a"),node("a")],wires:[]}),"operator").pipe(Effect.result);
  expect(failed._tag).toBe("Failure");
  expect((yield* model.open("factory")).nodes).toEqual([]);
  yield* sql.withTransaction(Effect.gen(function* () {
    yield* model.command(decode({_tag:"Add",canvas:"factory",nodes:[node("b")],wires:[]}),"operator");
    expect(seen).toEqual([]);
    return yield* Effect.fail("outer rollback");
  })).pipe(Effect.result);
  yield* Effect.yieldNow;
  expect(seen).toEqual([]);
  expect(yield* model.open("factory")).toMatchObject({seq:0,nodes:[],wires:[]});
  yield* Fiber.interrupt(subscriber);
})));

it("validates wire grammar, forbids cycles, and removes incident wires atomically",()=>run(model=>Effect.gen(function* () {
  yield* model.command(decode({_tag:"Add",canvas:"factory",nodes:[seat,node("t1","task"),node("t2","task")],wires:[{id:"w",from:"seat",to:"t1",verb:"contributes"},{id:"flow",from:"t1",to:"t2",verb:"feeds"}]}),"operator");
  expect((yield* model.command(decode({_tag:"Add",canvas:"factory",nodes:[],wires:[{id:"cycle",from:"t2",to:"t1",verb:"feeds"}]}),"operator").pipe(Effect.result))._tag).toBe("Failure");
  expect((yield* model.command(decode({_tag:"Rewire",canvas:"factory",id:"w",change:{verb:"navigates"}}),"operator").pipe(Effect.result))._tag).toBe("Failure");
  yield* model.command(decode({_tag:"Remove",canvas:"factory",nodes:["t1"],wires:[]}),"operator");
  expect((yield* model.open("factory")).wires).toEqual([]);
})));

it("keeps a sheet grid off Opened and placement events and admits seat authority by source",()=>run(model=>Effect.gen(function* () {
  const sheets:SheetChanged[]=[];
  const subscriber=yield* model.sheetChanges.pipe(Stream.runForEach(event=>Effect.sync(()=>{sheets.push(event);})),Effect.forkChild);
  yield* Effect.yieldNow;
  yield* model.command(decode({_tag:"Add",canvas:"factory",nodes:[seat,node("sheet","sheet")],wires:[]}),"operator");
  const grid={columns:[{id:"c",name:"Value"}],rows:[{id:"r",cells:{c:"123"}}]};
  yield* model.command(decode({_tag:"WriteSheet",canvas:"factory",id:"sheet",grid}),"operator");
  yield* Effect.yieldNow;
  expect(sheets).toEqual([{canvas:"factory",id:"sheet"}]);
  expect(yield* model.readSheet("factory","sheet")).toEqual(grid);
  expect((yield* model.open("factory")).nodes.find(node=>node.kind==="sheet")).not.toHaveProperty("rows");
  yield* model.command(decode({_tag:"Move",canvas:"factory",moves:[{id:"sheet",x:10,y:20,size:{width:300,height:100}}]}),"operator");
  expect(yield* model.readSheet("factory","sheet")).toEqual(grid);
  expect((yield* model.command(decode({_tag:"GrantOverseer",canvas:"factory",id:"seat",overseer:true}),"overseer").pipe(Effect.result))._tag).toBe("Failure");
  yield* model.command(decode({_tag:"GrantOverseer",canvas:"factory",id:"seat",overseer:true}),"operator");
  expect((yield* model.command(decode({_tag:"RecordSession",canvas:"factory",id:"seat",sessionId:"known"}),"operator").pipe(Effect.result))._tag).toBe("Failure");
  yield* model.command(decode({_tag:"RecordSession",canvas:"factory",id:"seat",sessionId:"known"}),"runtime");
  expect((yield* model.open("factory")).nodes.find(node=>node.kind==="agent")).toMatchObject({overseer:true,sessionId:"known"});
  yield* Fiber.interrupt(subscriber);
})));
