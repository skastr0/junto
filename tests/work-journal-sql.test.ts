import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import { DisplayTimestamp, LogicalSequence, WorkRecord } from "../src/shared/work-protocol";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import {
  WorkJournal, WorkJournalLive, appendPendingCommand, appendWorkRecord,
  rememberIncomingSequence,
} from "../src/main/junto/work/journal";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/station-protocol-1-golden-corpus.json", import.meta.url), "utf8"));
const decodeRecord = Schema.decodeUnknownSync(WorkRecord);
const receivedAt = Schema.decodeUnknownSync(DisplayTimestamp)("2026-08-02T13:24:56.000Z");
const tables = ["work_event_sequences", "work_events", "work_commands", "work_facts", "work_dispositions", "work_pending_commands"];

test.each(["appliedDisposition", "rejectedDisposition"])("SQL journal preserves stored %s rows exactly", async (dispositionName) => {
  const root = await mkdtemp(join(tmpdir(), "junto-journal-sql-"));
  const engine = makeStateEngineLive(join(root, "sql.db"));
  const runtime = ManagedRuntime.make(WorkJournalLive.pipe(Layer.provideMerge(engine)));
  const legacy = ManagedRuntime.make(makeStateEngineLive(join(root, "legacy.db")));
  const command = decodeRecord(corpus.work.taskClaimCommand);
  const disposition = decodeRecord(corpus.work[dispositionName]);
  if (command.recordType !== "command" || disposition.recordType !== "disposition") throw new Error("wrong fixture");
  const records = [command, decodeRecord(corpus.work.taskClaimFact), disposition];
  try {
    await legacy.runPromise(Effect.gen(function* () {
      const state = yield* StateEngine;
      yield* state.transaction("test.journal.legacy", (writer) => {
        for (const home of ["cc-inst-01", "remote-inst-01"]) {
          writer.run("INSERT INTO station_known_installations(installation_id, registered_at) VALUES (?, ?)", [home, receivedAt]);
        }
        for (const record of records) {
          rememberIncomingSequence(writer, record.id);
          appendWorkRecord(writer, record, receivedAt);
          if (record.recordType === "command") appendPendingCommand(writer, record, receivedAt);
        }
      });
    }));
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* WorkJournal;
      yield* sql.withTransaction(Effect.gen(function* () {
        for (const home of ["cc-inst-01", "remote-inst-01"]) {
          yield* sql`INSERT INTO station_known_installations(installation_id, registered_at) VALUES (${home}, ${receivedAt})`;
        }
        for (const record of records) {
          yield* journal.rememberIncomingSequence(record.id);
          yield* journal.appendWorkRecord(record, receivedAt);
          if (record.recordType === "command") yield* journal.appendPendingCommand(record, receivedAt);
        }
      }));
    }));
    for (const table of tables) {
      const query = `SELECT * FROM ${table} ORDER BY event_home, entity_home${table === "work_event_sequences" ? "" : ", seq"}`;
      const expected = await legacy.runPromise(Effect.flatMap(StateEngine, (state) =>
        state.read("test.journal.rows", (reader) => reader.all(query))));
      const actual = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(query)));
      expect(actual, table).toEqual(expected);
    }
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* WorkJournal;
      // The fixture's immutable append is already committed for the parity read.
      yield* sql.withTransaction(unjournaledWorkMutationEffect("test.fixture-seed", Effect.gen(function* () {
        expect(yield* journal.resolvePending(disposition, receivedAt)).toBe("resolved");
        expect(yield* journal.resolvePending(disposition, receivedAt)).toBe("same");
        const other = decodeRecord(corpus.work[dispositionName === "appliedDisposition" ? "rejectedDisposition" : "appliedDisposition"]);
        if (other.recordType !== "disposition") throw new Error("wrong fixture");
        expect(yield* journal.resolvePending(other, receivedAt)).toBe("conflict");
        const absent = { ...disposition, body: { ...disposition.body, command: { ...command.id, seq: Schema.decodeUnknownSync(LogicalSequence)("27") } } };
        expect(yield* journal.resolvePending(absent, receivedAt)).toBe("missing");
      })));
      expect(yield* sql`SELECT resolution_status, resolved_at FROM work_pending_commands`)
        .toEqual([{ resolution_status: disposition.body.status, resolved_at: receivedAt }]);
    }));
  } finally {
    await runtime.dispose();
    await legacy.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQL journal sequences retain zero, bigint precision, high-water marks and rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-journal-sql-"));
  const runtime = ManagedRuntime.make(WorkJournalLive.pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))));
  const home = Schema.decodeUnknownSync(InstallationId)("journal-sequence-home");
  const route = { eventHome: home, entityHome: home };
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* WorkJournal;
      yield* sql.withTransaction(unjournaledWorkMutationEffect("test.fixture-seed", Effect.gen(function* () {
        yield* sql`INSERT INTO station_known_installations(installation_id, registered_at) VALUES (${home}, ${receivedAt})`;
        yield* sql`INSERT INTO work_event_sequences VALUES (${home}, ${home}, '0')`;
        expect(yield* journal.allocateSequence(home, home)).toBe("1");
        yield* journal.rememberIncomingSequence({ route, seq: Schema.decodeUnknownSync(LogicalSequence)("9007199254740993") });
        yield* journal.rememberIncomingSequence({ route, seq: Schema.decodeUnknownSync(LogicalSequence)("7") });
        expect(yield* journal.allocateSequence(home, home)).toBe("9007199254740994");
        yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
          expect(yield* journal.allocateSequence(home, home)).toBe("9007199254740995");
          return yield* Effect.fail("rollback");
        })));
        expect(yield* journal.allocateSequence(home, home)).toBe("9007199254740995");
      })));
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
