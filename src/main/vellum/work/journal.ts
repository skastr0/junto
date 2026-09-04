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
 * in the same transaction. `scripts/lint-single-write-seam.ts` pins this file
 * as the sole writer of the journal tables, so "append a work record" has
 * exactly one implementation and one call shape.
 *
 * Nothing here decides anything. Minting, validation, authority, and
 * materialization all live in `./repository.ts`; this module only writes the
 * record it is handed, in the shape `work/state-schema.ts` declares.
 */
import { Schema } from "effect";
import type { InstallationId } from "@shared/installation-id";
import {
  LogicalSequence,
  type DisplayTimestamp as DisplayTimestampValue,
  type LogicalSequence as LogicalSequenceValue,
  type WorkCommand as WorkCommandValue,
  type WorkRecord as WorkRecordValue,
  type WorkRecordId,
} from "@shared/work-protocol";
import type { StateRow, StateWriter } from "../state/service";
import { canonicalJson } from "./canonical-json";

type SequenceRow = StateRow & {
  readonly last_seq: string;
};

const sequence = (value: string): LogicalSequenceValue =>
  Schema.decodeUnknownSync(LogicalSequence)(value);

/**
 * Reserve the next logical sequence for a route this installation authors.
 * Runs immediately before the record it numbers, inside the same transaction.
 */
export const allocateSequence = (
  writer: StateWriter,
  eventHome: InstallationId,
  entityHome: InstallationId,
): LogicalSequenceValue => {
  const current = writer.get<SequenceRow>(
    `
      SELECT last_seq
      FROM work_event_sequences
      WHERE event_home = ? AND entity_home = ?
    `,
    [eventHome, entityHome],
  )?.last_seq;
  const next = (current === undefined ? 1n : BigInt(current) + 1n).toString();
  writer.run(
    `
      INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
      VALUES (?, ?, ?)
      ON CONFLICT(event_home, entity_home) DO UPDATE SET
        last_seq = excluded.last_seq
    `,
    [eventHome, entityHome, next],
  );
  return sequence(next);
};

/**
 * Advance the local high-water mark for a route another installation authors,
 * so a later local append never reuses a sequence a peer already spent.
 */
export const rememberIncomingSequence = (
  writer: StateWriter,
  identity: WorkRecordId,
): void => {
  const current = writer.get<SequenceRow>(
    `
      SELECT last_seq
      FROM work_event_sequences
      WHERE event_home = ? AND entity_home = ?
    `,
    [identity.route.eventHome, identity.route.entityHome],
  )?.last_seq;
  if (current !== undefined && BigInt(current) >= BigInt(identity.seq)) return;
  writer.run(
    `
      INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
      VALUES (?, ?, ?)
      ON CONFLICT(event_home, entity_home) DO UPDATE SET
        last_seq = excluded.last_seq
    `,
    [
      identity.route.eventHome,
      identity.route.entityHome,
      identity.seq,
    ],
  );
};

/** Append one work record to the journal. The only journal write. */
export const appendWorkRecord = (
  writer: StateWriter,
  record: WorkRecordValue,
  receivedAt: DisplayTimestampValue,
): void => {
  writer.run(
    `
      INSERT INTO work_events(
        event_home,
        entity_home,
        seq,
        protocol,
        record_type,
        item_kind,
        item_id,
        item_canvas_name,
        item_node_id,
        operation,
        content_sha256,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.id.route.eventHome,
      record.id.route.entityHome,
      record.id.seq,
      record.protocol,
      record.recordType,
      record.item.kind,
      record.item.itemId,
      record.item.sink.canvasName,
      record.item.sink.nodeId,
      record.operation,
      record.contentSha256,
      record.originAt,
      receivedAt,
    ],
  );
  if (record.recordType === "command") {
    writer.run(
      `
        INSERT INTO work_commands(
          event_home,
          entity_home,
          seq,
          predecessor_event_home,
          predecessor_entity_home,
          predecessor_seq,
          action_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.id.route.eventHome,
        record.id.route.entityHome,
        record.id.seq,
        record.predecessor?.route.eventHome ?? null,
        record.predecessor?.route.entityHome ?? null,
        record.predecessor?.seq ?? null,
        canonicalJson(record.body),
      ],
    );
    return;
  }
  if (record.recordType === "fact") {
    writer.run(
      `
        INSERT INTO work_facts(
          event_home,
          entity_home,
          seq,
          predecessor_event_home,
          predecessor_entity_home,
          predecessor_seq,
          basis_kind,
          basis_authorial_generation,
          basis_authorial_content_sha256,
          basis_projected_generation,
          basis_projected_content_sha256,
          basis_command_event_home,
          basis_command_entity_home,
          basis_command_seq,
          basis_command_sha256,
          result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.id.route.eventHome,
        record.id.route.entityHome,
        record.id.seq,
        record.predecessor?.route.eventHome ?? null,
        record.predecessor?.route.entityHome ?? null,
        record.predecessor?.seq ?? null,
        record.basis.kind,
        record.basis.kind === "authorial-intent"
          ? record.basis.generation
          : null,
        record.basis.kind === "authorial-intent"
          ? record.basis.contentSha256
          : null,
        record.basis.kind === "projected-intent"
          ? record.basis.generation
          : null,
        record.basis.kind === "projected-intent"
          ? record.basis.contentSha256
          : null,
        record.basis.kind === "command"
          ? record.basis.command.route.eventHome
          : null,
        record.basis.kind === "command"
          ? record.basis.command.route.entityHome
          : null,
        record.basis.kind === "command"
          ? record.basis.command.seq
          : null,
        record.basis.kind === "command"
          ? record.basis.commandSha256
          : null,
        canonicalJson(record.body),
      ],
    );
    return;
  }
  writer.run(
    `
      INSERT INTO work_dispositions(
        event_home,
        entity_home,
        seq,
        status,
        command_event_home,
        command_entity_home,
        command_seq,
        command_sha256,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        fact_sha256,
        rejection_reason,
        rejection_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.id.route.eventHome,
      record.id.route.entityHome,
      record.id.seq,
      record.body.status,
      record.body.command.route.eventHome,
      record.body.command.route.entityHome,
      record.body.command.seq,
      record.body.commandSha256,
      record.body.status === "applied"
        ? record.body.fact.route.eventHome
        : null,
      record.body.status === "applied"
        ? record.body.fact.route.entityHome
        : null,
      record.body.status === "applied" ? record.body.fact.seq : null,
      record.body.status === "applied" ? record.body.factSha256 : null,
      record.body.status === "rejected" ? record.body.reason : null,
      record.body.status === "rejected" ? record.body.message : null,
    ],
  );
};

/**
 * Index a command as unresolved. Derived from the record just appended, and
 * cleared when its disposition lands.
 */
export const appendPendingCommand = (
  writer: StateWriter,
  command: WorkCommandValue,
  createdAt: DisplayTimestampValue,
): void => {
  writer.run(
    `
      INSERT INTO work_pending_commands(
        event_home,
        entity_home,
        seq,
        operation,
        item_kind,
        item_canvas_name,
        item_node_id,
        item_id,
        claim_actor_seat_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      command.id.route.eventHome,
      command.id.route.entityHome,
      command.id.seq,
      command.operation,
      command.item.kind,
      command.item.sink.canvasName,
      command.item.sink.nodeId,
      command.item.itemId,
      command.body.operation === "task.claim"
        ? command.body.actor.seatId
        : null,
      createdAt,
    ],
  );
};
