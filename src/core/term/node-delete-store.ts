import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { DeleteBindingUnprovenReason } from "@shared/terminal-delete";
import { coreRunner } from "../core-runner";

export type TerminalDeleteHeldRow = Readonly<{
  bindingId: string;
  canvasName: string;
  seatId: string;
  editorInstallationId: string;
  editorCanvasSeq: number;
  createdAt: number;
}>;

export type TerminalDeleteOwedRow = Readonly<{
  leaseId: string;
  bindingId: string;
  machineName: string;
  canvasName: string;
  seatId: string;
  reason: DeleteBindingUnprovenReason;
  createdAt: number;
}>;

/** Durable facts behind the terminal node-delete fence. Production rows go through the core's one SQL service. */
export interface TerminalNodeDeleteStore {
  readonly loadHeld: () => Promise<ReadonlyArray<TerminalDeleteHeldRow>>;
  /** Insert or raise a hold; the row returned is the one that governs, so an older replay never lowers the seq. */
  readonly hold: (row: TerminalDeleteHeldRow) => Promise<TerminalDeleteHeldRow>;
  /** Exact release: canvas, seat, editor and seq must all match. */
  readonly releaseHeld: (row: TerminalDeleteHeldRow) => Promise<boolean>;
  readonly writeOwed: (rows: ReadonlyArray<TerminalDeleteOwedRow>) => Promise<void>;
  readonly dropOwedLease: (leaseId: string) => Promise<void>;
  readonly sweepOwedMachine: (machineName: string) => Promise<void>;
}

type RawRow = Readonly<Record<string, unknown>>;

const heldOf = (row: RawRow): TerminalDeleteHeldRow => Object.freeze({
  bindingId: String(row.binding_id),
  canvasName: String(row.canvas_name),
  seatId: String(row.seat_id),
  editorInstallationId: String(row.editor_installation_id),
  editorCanvasSeq: Number(row.editor_canvas_seq),
  createdAt: Number(row.created_at),
});

const changesOf = (value: unknown): number =>
  typeof value === "object" && value !== null && "changes" in value ? Number((value as { changes: unknown }).changes) : 0;

/** The production store. Every statement enters the already-running core through coreRunner; nothing opens the database itself. */
export const makeSqlTerminalNodeDeleteStore = (): TerminalNodeDeleteStore => ({
  loadHeld: () => coreRunner.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe(`SELECT binding_id, canvas_name, seat_id, editor_installation_id, editor_canvas_seq, created_at
      FROM terminal_delete_held`);
    return (rows as ReadonlyArray<RawRow>).map(heldOf);
  })),
  hold: (row) => coreRunner.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO terminal_delete_held(
        binding_id, canvas_name, seat_id, editor_installation_id, editor_canvas_seq, created_at
      ) VALUES (
        ${row.bindingId}, ${row.canvasName}, ${row.seatId}, ${row.editorInstallationId}, ${row.editorCanvasSeq}, ${row.createdAt}
      )
      ON CONFLICT(binding_id) DO UPDATE SET
        canvas_name = excluded.canvas_name,
        seat_id = excluded.seat_id,
        editor_installation_id = excluded.editor_installation_id,
        editor_canvas_seq = excluded.editor_canvas_seq,
        created_at = excluded.created_at
      WHERE excluded.editor_canvas_seq > terminal_delete_held.editor_canvas_seq
    `;
    const rows = yield* sql`
      SELECT binding_id, canvas_name, seat_id, editor_installation_id, editor_canvas_seq, created_at
      FROM terminal_delete_held WHERE binding_id = ${row.bindingId}
    `;
    const held = (rows as ReadonlyArray<RawRow>)[0];
    if (held === undefined) throw new Error("terminal delete hold did not persist");
    return heldOf(held);
  })),
  releaseHeld: (row) => coreRunner.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changed = yield* sql`
      DELETE FROM terminal_delete_held
      WHERE binding_id = ${row.bindingId}
        AND canvas_name = ${row.canvasName}
        AND seat_id = ${row.seatId}
        AND editor_installation_id = ${row.editorInstallationId}
        AND editor_canvas_seq = ${row.editorCanvasSeq}
    `.raw;
    return changesOf(changed) > 0;
  })),
  writeOwed: (rows) => coreRunner.runPromise(Effect.gen(function* () {
    if (rows.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.forEach(rows, (row) => sql`
      INSERT INTO terminal_delete_owed(
        lease_id, binding_id, machine_name, canvas_name, seat_id, reason, created_at
      ) VALUES (
        ${row.leaseId}, ${row.bindingId}, ${row.machineName}, ${row.canvasName}, ${row.seatId}, ${row.reason}, ${row.createdAt}
      )
    `, { discard: true }));
  })),
  dropOwedLease: (leaseId) => coreRunner.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM terminal_delete_owed WHERE lease_id = ${leaseId}`;
  })),
  sweepOwedMachine: (machineName) => coreRunner.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM terminal_delete_owed WHERE machine_name = ${machineName}`;
  })),
});

/** Test and pre-core memory store, with the same seq and exact-release semantics. */
export const makeMemoryTerminalNodeDeleteStore = (): TerminalNodeDeleteStore => {
  const held = new Map<string, TerminalDeleteHeldRow>();
  const owed = new Map<string, TerminalDeleteOwedRow>();
  return {
    loadHeld: async () => [...held.values()],
    hold: async (row) => {
      const current = held.get(row.bindingId);
      if (current === undefined || row.editorCanvasSeq > current.editorCanvasSeq) {
        held.set(row.bindingId, row);
        return row;
      }
      return current;
    },
    releaseHeld: async (row) => {
      const current = held.get(row.bindingId);
      if (
        current === undefined ||
        current.canvasName !== row.canvasName ||
        current.seatId !== row.seatId ||
        current.editorInstallationId !== row.editorInstallationId ||
        current.editorCanvasSeq !== row.editorCanvasSeq
      ) return false;
      held.delete(row.bindingId);
      return true;
    },
    writeOwed: async (rows) => {
      for (const row of rows) owed.set(`${row.leaseId}\0${row.bindingId}\0${row.machineName}`, row);
    },
    dropOwedLease: async (leaseId) => {
      for (const [key, row] of [...owed]) if (row.leaseId === leaseId) owed.delete(key);
    },
    sweepOwedMachine: async (machineName) => {
      for (const [key, row] of [...owed]) if (row.machineName === machineName) owed.delete(key);
    },
  };
};
