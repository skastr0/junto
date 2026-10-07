import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ulid } from "ulid";
import { Changed, Command, Node, Wire, SheetChanged, type CanvasesChanged, type Opened } from "@shared/model";
import { compileVerb } from "@shared/physics/verbs";
import { afterSqlCommit } from "../state/sql-commit";
import { withSqlRead } from "../state/sql-read";
import { StateTransactionOperation } from "../state/service";
import { ModelError, ModelRecords, modelError } from "./records";

const patch = (original: object, change: object): object => {
  const result: Record<string,unknown>={...original};
  for(const [key,value] of Object.entries(change)) {
    if(value===null) delete result[key];
    else result[key]=value;
  }
  return result;
};

export class ModelService extends Context.Service<ModelService>()("@junto/ModelService", {
  make: Effect.gen(function* () {
    const sql=yield* SqlClient.SqlClient;
    const records=yield* ModelRecords;
    // Slow subscribers see a seq gap and reopen; they cannot stall a commit.
    const changes=yield* PubSub.sliding<Changed>(1024);
    const sheetChanges=yield* PubSub.sliding<SheetChanged>(256);
    const canvasChanges=yield* PubSub.sliding<CanvasesChanged>(64);
    const requireCanvas = Effect.fn("ModelService.requireCanvas")(function* (canvas:string) {
      const found=yield* records.getCanvas(canvas);
      if(!found) return yield* new ModelError({operation:"canvas",message:`canvas ${canvas} does not exist`,cause:canvas});
      return found;
    });
    const requireNode = Effect.fn("ModelService.requireNode")(function* (canvas:string,id:string) {
      const node=yield* records.getNode(canvas,id);
      if(!node) return yield* new ModelError({operation:"node",message:`object ${id} does not exist`,cause:{canvas,id}});
      return node;
    });
    const requireWire = Effect.fn("ModelService.requireWire")(function* (canvas:string,id:string) {
      const wire=yield* records.getWire(canvas,id);
      if(!wire) return yield* new ModelError({operation:"wire",message:`connection ${id} does not exist`,cause:{canvas,id}});
      return wire;
    });
    const validateWire = Effect.fn("ModelService.validateWire")(function* (canvas:string,wire:Wire) {
      const from=yield* requireNode(canvas,wire.from);
      const to=yield* requireNode(canvas,wire.to);
      if(compileVerb(wire.verb,from.kind,to.kind)===undefined) return yield* new ModelError({operation:"wire",message:"connection is not allowed between these kinds",cause:{from:from.kind,to:to.kind,verb:wire.verb}});
      if(wire.verb==="feeds" || wire.verb==="chains") {
        const existing=yield* records.listWires(canvas);
        const pending=[wire.to];
        const seen=new Set<string>();
        while(pending.length>0) {
          const current=pending.pop()!;
          if(current===wire.from) return yield* new ModelError({operation:"wire",message:"connection would create a cycle",cause:wire.id});
          if(seen.has(current)) continue;
          seen.add(current);
          for(const next of existing) if(next.id!==wire.id && next.verb===wire.verb && next.from===current) pending.push(next.to);
        }
      }
    });
    const open = Effect.fn("ModelService.open")((canvas:string)=>withSqlRead(sql,Effect.gen(function* () {
      const current=yield* requireCanvas(canvas);
      const nodes=yield* records.listNodes(canvas);
      const wires=yield* records.listWires(canvas);
      return {canvas:Schema.decodeUnknownSync(Changed.fields.canvas)(canvas),seq:current.seq,nodes,wires} satisfies Opened;
    })).pipe(Effect.mapError(cause=>modelError("open",cause))));

    const command = Effect.fn("ModelService.command")(function* (input:Command,source:"operator"|"runtime"|"overseer") {
      const command=yield* Schema.decodeUnknownEffect(Command)(input,{onExcessProperty:"error"}).pipe(Effect.mapError(cause=>modelError("command",cause)));
      if((command._tag==="GrantOverseer" && source!=="operator") || (command._tag==="RecordSession" && source!=="runtime"))
        return yield* new ModelError({operation:"admission",message:"command is not allowed from this source",cause:command._tag});
      yield* Effect.annotateCurrentSpan("canvas",command.canvas);
      yield* Effect.annotateCurrentSpan("command",command._tag);
      return yield* sql.withTransaction(Effect.gen(function* () {
        if(command._tag==="CreateCanvas") {
          yield* records.createCanvas(command.canvas,ulid());
          yield* afterSqlCommit(sql,()=>{PubSub.publishUnsafe(canvasChanges,{_tag:"Created",canvas:command.canvas});});
          return {seq:0};
        }
        yield* requireCanvas(command.canvas);
        if(command._tag==="RemoveCanvas" || command._tag==="RenameCanvas") {
          if(command._tag==="RemoveCanvas") yield* records.removeCanvas(command.canvas);
          else yield* records.renameCanvas(command.canvas,command.to);
          const event:CanvasesChanged=command._tag==="RemoveCanvas"?{_tag:"Removed",canvas:command.canvas}:{_tag:"Renamed",from:command.canvas,to:command.to};
          yield* afterSqlCommit(sql,()=>{PubSub.publishUnsafe(canvasChanges,event);});
          return {seq:command._tag==="RemoveCanvas"?0:(yield* requireCanvas(command.to)).seq};
        }
        const nodes:Node[]=[];
        const wires:Wire[]=[];
        const removedNodes:Changed["removedNodes"][number][]=[];
        const removedWires=new Set<Changed["removedWires"][number]>();
        switch(command._tag) {
          case "Add":
            for(const node of command.nodes) {
              if(node.kind==="agent" && (node.overseer && source!=="operator" || node.sessionId!==undefined && source!=="runtime")) return yield* new ModelError({operation:"add",message:"seat authority and session must come from their owners",cause:node.id});
              if(yield* records.kindOf(command.canvas,node.id)) return yield* new ModelError({operation:"add",message:"object identity already exists",cause:node.id});
              yield* records.insertNode(command.canvas,node);
              if(node.kind==="sheet") yield* records.writeSheet(command.canvas,node.id,{columns:[],rows:[]});
              nodes.push(node);
            }
            for(const wire of command.wires) {
              yield* validateWire(command.canvas,wire); yield* records.insertWire(command.canvas,wire); wires.push(wire);
            }
            break;
          case "Remove":
            for(const id of command.wires) {yield* requireWire(command.canvas,id);yield* records.removeWire(command.canvas,id);removedWires.add(id);}
            for(const id of command.nodes) {
              const node=yield* requireNode(command.canvas,id);
              for(const wire of yield* records.incidentWires(command.canvas,id)) {yield* records.removeWire(command.canvas,wire.id);removedWires.add(wire.id);}
              yield* records.removeNode(command.canvas,node);removedNodes.push(id);
            }
            break;
          case "Move":
            for(const move of command.moves) {
              const node=yield* requireNode(command.canvas,move.id);
              const next=yield* Schema.decodeUnknownEffect(Node)({...node,x:move.x,y:move.y,...move.size}).pipe(Effect.mapError(cause=>modelError("move",cause)));
              yield* records.updateNode(command.canvas,next);nodes.push(next);
            }
            break;
          case "Restack": {
            const selected=new Set(command.nodes);
            const all=yield* records.listNodes(command.canvas);
            for(const id of selected) if(!all.some(node=>node.id===id)) return yield* new ModelError({operation:"restack",message:"object does not exist",cause:id});
            const moving=all.filter(node=>selected.has(node.id));
            const staying=all.filter(node=>!selected.has(node.id));
            const ordered=command.to==="front"?[...staying,...moving]:[...moving,...staying];
            for(const [z,node] of ordered.entries()) if(node.z!==z) {
              const next={...node,z};yield* records.updateNode(command.canvas,next);nodes.push(next);
            }
            break;
          }
          case "Recolor":
            for(const id of command.nodes) {
              const node=yield* requireNode(command.canvas,id);
              const next=yield* Schema.decodeUnknownEffect(Node)(patch(node,{color:command.color})).pipe(Effect.mapError(cause=>modelError("recolor",cause)));
              yield* records.updateNode(command.canvas,next);nodes.push(next);
            }
            break;
          case "Edit": {
            const node=yield* requireNode(command.canvas,command.id);
            if(node.kind!==command.change.kind) return yield* new ModelError({operation:"edit",message:"edit belongs to another kind",cause:command.id});
            const next=yield* Schema.decodeUnknownEffect(Node)(patch(node,command.change),{onExcessProperty:"error"}).pipe(Effect.mapError(cause=>modelError("edit",cause)));
            yield* records.updateNode(command.canvas,next);nodes.push(next);break;
          }
          case "GrantOverseer": case "RecordSession": {
            const node=yield* requireNode(command.canvas,command.id);
            if(node.kind!=="agent") return yield* new ModelError({operation:"seat",message:"command requires a seat",cause:command.id});
            const next=yield* Schema.decodeUnknownEffect(Node)(patch(node,command._tag==="GrantOverseer"?{overseer:command.overseer}:{sessionId:command.sessionId})).pipe(Effect.mapError(cause=>modelError("seat",cause)));
            yield* records.updateNode(command.canvas,next);nodes.push(next);break;
          }
          case "WriteSheet": {
            const node=yield* requireNode(command.canvas,command.id);
            if(node.kind!=="sheet") return yield* new ModelError({operation:"sheet",message:"command requires a sheet",cause:command.id});
            yield* records.writeSheet(command.canvas,command.id,command.grid);
            yield* afterSqlCommit(sql,()=>{PubSub.publishUnsafe(sheetChanges,{canvas:command.canvas,id:command.id});});
            return {seq:(yield* requireCanvas(command.canvas)).seq};
          }
          case "Rewire": {
            const current=yield* requireWire(command.canvas,command.id);
            const next=yield* Schema.decodeUnknownEffect(Wire)(patch(current,command.change),{onExcessProperty:"error"}).pipe(Effect.mapError(cause=>modelError("rewire",cause)));
            yield* validateWire(command.canvas,next);yield* records.updateWire(command.canvas,next);wires.push(next);break;
          }
        }
        const seq=yield* records.advanceSeq(command.canvas);
        const event:Changed={canvas:command.canvas,seq,nodes,wires,removedNodes,removedWires:[...removedWires]};
        yield* afterSqlCommit(sql,()=>{PubSub.publishUnsafe(changes,event);});
        return {seq};
      })).pipe(Effect.provideService(StateTransactionOperation,`model.${command._tag}`),Effect.mapError(cause=>modelError("command",cause)));
    });
    return {open,command,listCanvases:records.listCanvases,readSheet:records.readSheet,sheetChanges:Stream.fromPubSub(sheetChanges),
      changes:Stream.fromPubSub(changes),canvasesChanges:Stream.fromPubSub(canvasChanges)};
  }),
}) {
  static readonly layer=Layer.effect(this,this.make).pipe(Layer.provide(ModelRecords.layer));
}
