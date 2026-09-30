/**
 * The work event journal — the append.
 *
 * SQLite is the factory world's append-only journal, and this module is the
 * only place a journal record is written. Every durable work transition is a
 * `WorkRecordValue` (command | fact | disposition) appended here; the
 * materialized `work_*` projection is a rebuildable consequence of these rows,
 * never an independent truth.
 *
 * The runtime seam (`./mutation-seam.ts`) reads the same law from the other
 * side: a projection write is admitted only after one of these appends has run
 * in the same transaction. WorkJournal owns the SQL for appending records and
 * resolving their pending-command index in that caller-owned transaction.
 *
 * Nothing here decides anything. Minting, validation, authority, and
 * materialization all live in `./repository.ts`; this module only writes the
 * record it is handed, in the shape `work/state-schema.ts` declares.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import type { InstallationId } from "@shared/installation-id";
import {
  LogicalSequence,
  type DisplayTimestamp as DisplayTimestampValue,
  type LogicalSequence as LogicalSequenceValue,
  type WorkCommand as WorkCommandValue,
  type WorkRecord as WorkRecordValue,
  type WorkRecordId,
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
    readonly rememberIncomingSequence: (
      identity: WorkRecordId,
    ) => Effect.Effect<void, WorkJournalError>;
    readonly appendWorkRecord: (
      record: WorkRecordValue,
      receivedAt: DisplayTimestampValue,
    ) => Effect.Effect<void, WorkJournalError>;
    readonly appendPendingCommand: (
      command: WorkCommandValue,
      createdAt: DisplayTimestampValue,
    ) => Effect.Effect<void, WorkJournalError>;
    readonly resolvePending: (
      disposition: WorkRecordValue & { readonly recordType: "disposition" },
      receivedAt: DisplayTimestampValue,
    ) => Effect.Effect<
      "resolved" | "same" | "missing" | "conflict",
      WorkJournalError
    >;
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
    const rememberIncomingSequenceEffect = Effect.fn(
      "work.journal.rememberIncomingSequence",
    )(function* (identity: WorkRecordId) {
      const { eventHome, entityHome } = identity.route;
      const previous = yield* currentSequence([eventHome, entityHome]);
      if (
        previous._tag === "Some" &&
        BigInt(previous.value.last_seq) >= BigInt(identity.seq)
      )
        return;
      yield* advance(eventHome, entityHome, identity.seq);
    });
    const appendWorkRecordEffect = Effect.fn("work.journal.appendWorkRecord")(
      function* (record: WorkRecordValue, receivedAt: DisplayTimestampValue) {
        const { eventHome, entityHome } = record.id.route;
        yield* sql`
        INSERT INTO work_events(event_home, entity_home, seq, protocol, record_type, item_kind,
          item_id, item_canvas_name, item_node_id, operation, content_sha256, origin_at, received_at)
        VALUES (${eventHome}, ${entityHome}, ${record.id.seq}, ${record.protocol}, ${record.recordType},
          ${record.item.kind}, ${record.item.itemId}, ${record.item.sink.canvasName}, ${record.item.sink.nodeId},
          ${record.operation}, ${record.contentSha256}, ${record.originAt}, ${receivedAt})
      `;
        if (record.recordType === "command") {
          yield* sql`
          INSERT INTO work_commands(event_home, entity_home, seq, predecessor_event_home,
            predecessor_entity_home, predecessor_seq, action_json)
          VALUES (${eventHome}, ${entityHome}, ${record.id.seq}, ${record.predecessor?.route.eventHome ?? null},
            ${record.predecessor?.route.entityHome ?? null}, ${record.predecessor?.seq ?? null}, ${canonicalJson(record.body)})
        `;
        } else if (record.recordType === "fact") {
          yield* sql`
          INSERT INTO work_facts(event_home, entity_home, seq, predecessor_event_home,
            predecessor_entity_home, predecessor_seq, basis_kind, basis_authorial_generation,
            basis_authorial_content_sha256, basis_projected_generation, basis_projected_content_sha256,
            basis_command_event_home, basis_command_entity_home, basis_command_seq, basis_command_sha256, result_json)
          VALUES (${eventHome}, ${entityHome}, ${record.id.seq}, ${record.predecessor?.route.eventHome ?? null},
            ${record.predecessor?.route.entityHome ?? null}, ${record.predecessor?.seq ?? null}, ${record.basis.kind},
            ${record.basis.kind === "authorial-intent" ? record.basis.generation : null},
            ${record.basis.kind === "authorial-intent" ? record.basis.contentSha256 : null},
            ${record.basis.kind === "projected-intent" ? record.basis.generation : null},
            ${record.basis.kind === "projected-intent" ? record.basis.contentSha256 : null},
            ${record.basis.kind === "command" ? record.basis.command.route.eventHome : null},
            ${record.basis.kind === "command" ? record.basis.command.route.entityHome : null},
            ${record.basis.kind === "command" ? record.basis.command.seq : null},
            ${record.basis.kind === "command" ? record.basis.commandSha256 : null}, ${canonicalJson(record.body)})
        `;
        } else {
          yield* sql`
          INSERT INTO work_dispositions(event_home, entity_home, seq, status, command_event_home,
            command_entity_home, command_seq, command_sha256, fact_event_home, fact_entity_home,
            fact_seq, fact_sha256, rejection_reason, rejection_message)
          VALUES (${eventHome}, ${entityHome}, ${record.id.seq}, ${record.body.status},
            ${record.body.command.route.eventHome}, ${record.body.command.route.entityHome}, ${record.body.command.seq},
            ${record.body.commandSha256}, ${record.body.status === "applied" ? record.body.fact.route.eventHome : null},
            ${record.body.status === "applied" ? record.body.fact.route.entityHome : null},
            ${record.body.status === "applied" ? record.body.fact.seq : null},
            ${record.body.status === "applied" ? record.body.factSha256 : null},
            ${record.body.status === "rejected" ? record.body.reason : null},
            ${record.body.status === "rejected" ? record.body.message : null})
        `;
        }
      },
    );
    const appendPendingCommandEffect = Effect.fn(
      "work.journal.appendPendingCommand",
    )(function* (command: WorkCommandValue, createdAt: DisplayTimestampValue) {
      yield* sql`
        INSERT INTO work_pending_commands(event_home, entity_home, seq, operation, item_kind,
          item_canvas_name, item_node_id, item_id, claim_actor_seat_id, created_at)
        VALUES (${command.id.route.eventHome}, ${command.id.route.entityHome}, ${command.id.seq},
          ${command.operation}, ${command.item.kind}, ${command.item.sink.canvasName}, ${command.item.sink.nodeId},
          ${command.item.itemId}, ${command.body.operation === "task.claim" ? command.body.actor.seatId : null}, ${createdAt})
      `;
    });
    const pendingRow = SqlSchema.findOneOption({
      Request: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
      Result: Schema.Struct({
        resolution_status: Schema.NullOr(Schema.String),
        resolution_event_home: Schema.NullOr(Schema.String),
        resolution_entity_home: Schema.NullOr(Schema.String),
        resolution_seq: Schema.NullOr(Schema.String),
      }),
      execute: ([eventHome, entityHome, seq]) => sql`
        SELECT resolution_status, resolution_event_home, resolution_entity_home, resolution_seq
        FROM work_pending_commands
        WHERE event_home = ${eventHome} AND entity_home = ${entityHome} AND seq = ${seq}
      `,
    });
    const resolvePending = Effect.fn("work.journal.resolvePending")(function* (
      disposition: WorkRecordValue & { readonly recordType: "disposition" },
      receivedAt: DisplayTimestampValue,
    ) {
      const command = disposition.body.command;
      const pending = yield* pendingRow([
        command.route.eventHome,
        command.route.entityHome,
        command.seq,
      ]);
      if (pending._tag === "None") return "missing" as const;
      if (pending.value.resolution_event_home !== null) {
        return pending.value.resolution_status === disposition.body.status &&
          pending.value.resolution_event_home ===
            disposition.id.route.eventHome &&
          pending.value.resolution_entity_home ===
            disposition.id.route.entityHome &&
          pending.value.resolution_seq === disposition.id.seq
          ? ("same" as const)
          : ("conflict" as const);
      }
      yield* sql`
        UPDATE work_pending_commands
        SET resolution_status = ${disposition.body.status}, resolution_event_home = ${disposition.id.route.eventHome},
            resolution_entity_home = ${disposition.id.route.entityHome}, resolution_seq = ${disposition.id.seq}, resolved_at = ${receivedAt}
        WHERE event_home = ${command.route.eventHome} AND entity_home = ${command.route.entityHome} AND seq = ${command.seq}
      `;
      return "resolved" as const;
    });
    return WorkJournal.of({
      allocateSequence: allocateSequenceEffect,
      rememberIncomingSequence: rememberIncomingSequenceEffect,
      appendWorkRecord: appendWorkRecordEffect,
      appendPendingCommand: appendPendingCommandEffect,
      resolvePending,
    });
  }),
);
