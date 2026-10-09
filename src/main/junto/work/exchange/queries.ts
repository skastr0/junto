import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MachineExchangeData, type MachineExchangeInput } from "@shared/machine-exchange";
import { asCanvasName } from "@shared/model";
import { MachineRepository } from "../../machines/repository";
import { ModelRecords } from "../../model/records";
import { withSqlRead } from "../../state/sql-read";
import { WorkRepository } from "../repository";
import type { RowExchange } from "./session";

export const makeMachineExchangeQuery = (exchange: RowExchange) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const records = yield* ModelRecords;
  const repository = yield* WorkRepository;
  const sql = yield* SqlClient.SqlClient;
  return (input: MachineExchangeInput) => withSqlRead(sql, Effect.gen(function* () {
    const installationId = yield* machines.installationId;
    const machineName = yield* machines.machineName;
    const pins = yield* machines.peers;
    const names = new Map<string, string>([[installationId, machineName], ...pins.map(pin => [pin.installationId, pin.machineName] as const)]);
    const links = exchange.status();
    const candidates = (yield* records.listCanvases()).filter(name =>
      (input.canvas === undefined || name === input.canvas) && (input.after === undefined || name > input.after)).sort();
    const canvases = [];
    for (const name of candidates.slice(0, 64)) {
      const header = yield* records.getCanvas(name);
      if (header === undefined) continue;
      const editor = (yield* records.canvasEditor(name)) ?? installationId;
      const held = [];
      for (const link of links) {
        const machineName = names.get(link.peer);
        if (machineName === undefined) continue;
        const counts = link.rows.find(row => row.canvasName === name);
        held.push({ machineName, installationId: link.peer, sent: counts?.sent ?? 0, taken: counts?.taken ?? 0,
          waiting: yield* exchange.waiting(name, link.peer) });
      }
      canvases.push({
        canvasName: asCanvasName(name), canvasId: header.canvas_id, editor,
        ...(names.has(editor) ? { editorMachine: names.get(editor)! } : {}), seq: header.seq,
        cursors: (yield* repository.exchangeHave(name)).map(cursor => ({ ...cursor,
          ...(names.has(cursor.writer) ? { machineName: names.get(cursor.writer)! } : {}),
        })),
        links: held,
      });
    }
    return yield* Schema.decodeUnknownEffect(MachineExchangeData, { onExcessProperty: "error" })({
      machineName, installationId, canvases,
      ...(candidates.length > 64 ? { next: asCanvasName(candidates[63]!) } : {}),
    });
  }));
});
