/**
 * The work journal: the append.
 *
 * SQLite is the append-only journal of work, and this module is the only
 * place a journal record is written. Every durable work change is a fact
 * appended here; the materialized `work_*` rows are a rebuildable consequence
 * of those facts, never an independent truth.
 *
 * The runtime seam (`./mutation-seam.ts`) reads the same law from the other
 * side: a write to a materialized row is admitted only after one of these
 * appends has run in the same transaction. WorkJournal owns the SQL for
 * appending a fact in that caller-owned transaction.
 *
 * Nothing here decides anything. Minting, validation, authority, and
 * materialization all live in `./repository.ts`; this module only writes the
 * fact it is handed, in the shape `work/state-schema.ts` declares.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import type { InstallationId } from "@shared/installation-id";
import {
  LogicalSequence,
  type DisplayTimestamp as DisplayTimestampValue,
  type LogicalSequence as LogicalSequenceValue,
  type WorkFact as WorkFactValue,
} from "@shared/work-protocol";
import { canonicalJson } from "./canonical-json";

type WorkJournalError = SqlError.SqlError | Schema.SchemaError;

/** Journal operations join the caller's SQL transaction; they never open one. */
export class WorkJournal extends Context.Service<
  WorkJournal,
  {
    readonly allocateSequence: (
      eventHome: InstallationId,
      entityHome: InstallationId,
    ) => Effect.Effect<LogicalSequenceValue, WorkJournalError>;
    readonly appendWorkRecord: (
      record: WorkFactValue,
      receivedAt: DisplayTimestampValue,
    ) => Effect.Effect<void, WorkJournalError>;
  }
>()("@junto/WorkJournal") {}

const SequenceRowSchema = Schema.Struct({
  // An existing route may not have spent its first sequence yet.
  last_seq: Schema.Union([Schema.Literal("0"), LogicalSequence]),
});

export const WorkJournalLive: Layer.Layer<
  WorkJournal,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  WorkJournal,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const currentSequence = SqlSchema.findOneOption({
      Request: Schema.Tuple([Schema.String, Schema.String]),
      Result: SequenceRowSchema,
      execute: ([eventHome, entityHome]) => sql`
        SELECT last_seq FROM work_event_sequences
        WHERE event_home = ${eventHome} AND entity_home = ${entityHome}
      `,
    });
    const advance = (eventHome: string, entityHome: string, seq: string) => sql`
      INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
      VALUES (${eventHome}, ${entityHome}, ${seq})
      ON CONFLICT(event_home, entity_home) DO UPDATE SET last_seq = excluded.last_seq
    `;
    const allocateSequenceEffect = Effect.fn("work.journal.allocateSequence")(
      function* (eventHome: InstallationId, entityHome: InstallationId) {
        const previous = yield* currentSequence([eventHome, entityHome]);
        const next = (
          previous._tag === "None" ? 1n : BigInt(previous.value.last_seq) + 1n
        ).toString();
        yield* advance(eventHome, entityHome, next);
        return yield* Schema.decodeUnknownEffect(LogicalSequence)(next);
      },
    );
    const appendWorkRecordEffect = Effect.fn("work.journal.appendWorkRecord")(
      function* (record: WorkFactValue, receivedAt: DisplayTimestampValue) {
        if (record.basis.kind === "historical") {
          return yield* Effect.die(new Error("historical Work facts can only be installed by migration"));
        }
        const { eventHome, entityHome } = record.id.route;
        yield* sql`
        INSERT INTO work_events(event_home, entity_home, seq, protocol, record_type, item_kind,
          item_id, item_canvas_name, item_node_id, operation, content_sha256, origin_at, received_at)
        VALUES (${eventHome}, ${entityHome}, ${record.id.seq}, ${record.protocol}, ${record.recordType},
          ${record.item.kind}, ${record.item.itemId}, ${record.item.sink.canvasName}, ${record.item.sink.nodeId},
          ${record.operation}, ${record.contentSha256}, ${record.originAt}, ${receivedAt})
      `;
        yield* sql`
        INSERT INTO work_facts(event_home, entity_home, seq, predecessor_event_home,
          predecessor_entity_home, predecessor_seq, basis_kind, basis_canvas_name,
          basis_canvas_seq, basis_projected_generation, basis_projected_content_sha256,
          basis_command_event_home, basis_command_entity_home, basis_command_seq, basis_command_sha256, result_json)
        VALUES (${eventHome}, ${entityHome}, ${record.id.seq}, ${record.predecessor?.route.eventHome ?? null},
          ${record.predecessor?.route.entityHome ?? null}, ${record.predecessor?.seq ?? null}, ${record.basis.kind},
          ${record.basis.kind === "canvas" ? record.basis.canvasName : null},
          ${record.basis.kind === "canvas" ? record.basis.seq : null},
          ${record.basis.kind === "projected-intent" ? record.basis.generation : null},
          ${record.basis.kind === "projected-intent" ? record.basis.contentSha256 : null},
          ${record.basis.kind === "command" ? record.basis.command.route.eventHome : null},
          ${record.basis.kind === "command" ? record.basis.command.route.entityHome : null},
          ${record.basis.kind === "command" ? record.basis.command.seq : null},
          ${record.basis.kind === "command" ? record.basis.commandSha256 : null}, ${canonicalJson(record.body)})
      `;
      },
    );
    return WorkJournal.of({
      allocateSequence: allocateSequenceEffect,
      appendWorkRecord: appendWorkRecordEffect,
    });
  }),
);
