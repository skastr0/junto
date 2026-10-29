import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { ulid } from "ulid";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import {
  type AgentSignal,
  type AgentSignalAttachment,
  type AgentSignalAttachmentKind,
  AgentSignalKind,
  AgentSignalState,
  SignalForm as SignalFormSchema,
  type SignalForm,
  SignalSource as SignalSourceSchema,
  type SignalSource,
  WorkTiming as WorkTimingSchema,
  type WorkTiming,
} from "@shared/agent-signals";
import type { ContentRef } from "@shared/wire/content-ref";
import { SignalReplySecret, type SignalReplyArtifact } from "@shared/agent-signals";
import { StateTransactionOperation } from "../state/service";
import { emitAgentSignalChanged } from "./changes";

export class AgentSignalPersistenceError extends Schema.TaggedError<AgentSignalPersistenceError>()(
  "AgentSignalPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** The signal does not exist, or is not open, or is not this seat's. */
export class AgentSignalNotFound extends Schema.TaggedError<AgentSignalNotFound>()(
  "AgentSignalNotFound",
  {
    signalId: Schema.String,
    message: Schema.String,
  },
) {}

export type AgentSignalRepositoryError =
  | AgentSignalPersistenceError
  | AgentSignalNotFound;

export type AgentSignalSeat = {
  readonly canvasName: string;
  readonly nodeId: string;
};

export type RaiseAgentSignal = AgentSignalSeat & {
  readonly kind: AgentSignalKind;
  readonly text: string;
  readonly detail?: string;
  /** Who raised it; absent is the seat at `nodeId`. */
  readonly source?: SignalSource;
  /** A work signal's due time and urgent mark. */
  readonly work?: WorkTiming;
  /** The reply it asks for, one per signal. */
  readonly form?: SignalForm;
  /**
   * The id to raise under, when the caller had to name the signal before it
   * existed (its attachments are stored under it first). Default: a new one.
   */
  readonly signalId?: string;
  /** Already in the content store, in the order the agent gave them. */
  readonly attachments?: ReadonlyArray<AgentSignalAttachment>;
  /** Replies the seat pre-baked for the operator, at most two, in order. */
  readonly suggestions?: ReadonlyArray<string>;
};

/**
 * A signal as another machine wrote it: the raise by the machine its seat
 * lives on, and the closing by the machine entitled to write it. Its words
 * cross, and what it attached by reference (`takenSignalAttachments`): a
 * file's bytes come later, pulled from the seat's machine.
 */
export type TakenAgentSignal = AgentSignalSeat & {
  readonly signalId: string;
  readonly kind: AgentSignalKind;
  readonly text: string;
  readonly detail?: string;
  readonly source?: SignalSource;
  readonly work?: WorkTiming;
  readonly form?: SignalForm;
  /** Pre-baked replies the raise carried, when the sender stated them. */
  readonly suggestions?: ReadonlyArray<string>;
  /** What the raise attached, as kept here: a file of no stated kind until judged. */
  readonly attachments?: ReadonlyArray<AgentSignalAttachment>;
  readonly createdAt: number;
  /** The closing to take, when the sender is the one that may write it. */
  readonly closing?:
    | { readonly state: "withdrawn" | "dismissed"; readonly closedAt: number }
    | { readonly state: "answered"; readonly closedAt: number; readonly response: { readonly text: string; readonly at: number } };
  /** May the sender raise this signal: it is the machine the seat lives on. */
  readonly raises: boolean;
};

/** Closed signals kept per seat in listings; open ones are always listed. */
export const AGENT_SIGNAL_CLOSED_HISTORY = 20;

/** Where a signal listing's closed history starts: after a signal id, or at a time. */
export type SignalSinceCursor = { readonly afterId: string } | { readonly fromMs: number };

/**
 * Durable agent signals (`agent_signals`). Seat-side writes take the caller's
 * own seat and never a foreign one; operator-side writes take a signal id.
 */
export class AgentSignalRepository extends Context.Service<AgentSignalRepository,
  {
    readonly raise: (
      input: RaiseAgentSignal,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
    /**
     * The seat withdraws its own open signals: one by id, or all when no id.
     * An id that is not an open signal of this seat fails `AgentSignalNotFound`.
     */
    readonly withdraw: (
      seat: AgentSignalSeat,
      signalId?: string,
    ) => Effect.Effect<ReadonlyArray<AgentSignal>, AgentSignalRepositoryError>;
    /**
     * A seat's open signals and its newest closed history. With a since
     * cursor the closed history is uncapped and starts after that signal id,
     * or at that time; open signals are always listed.
     */
    readonly listSeat: (
      seat: AgentSignalSeat,
      since?: SignalSinceCursor,
    ) => Effect.Effect<ReadonlyArray<AgentSignal>, AgentSignalRepositoryError>;
    /** How many closed signals a seat has in all. */
    readonly countClosedSeat: (
      seat: AgentSignalSeat,
    ) => Effect.Effect<number, AgentSignalRepositoryError>;
    /** Every open blocked or escalate signal, on every canvas: raised hands. */
    readonly listRaisedHands: Effect.Effect<
      ReadonlyArray<AgentSignal>,
      AgentSignalRepositoryError
    >;
    /** Open signals plus recent history for every seat on a canvas. */
    readonly listCanvas: (
      canvasName: string,
    ) => Effect.Effect<ReadonlyArray<AgentSignal>, AgentSignalRepositoryError>;
    readonly get: (
      signalId: string,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
    /** Operator answer: open to answered with the response recorded, and its files in order. */
    readonly answer: (
      signalId: string,
      text: string,
      files?: ReadonlyArray<ContentRef>,
      /** What a work form's reply left: its document, or its proof's addresses. */
      reply?: SignalReplyRecord,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
    readonly dismiss: (
      signalId: string,
    ) => Effect.Effect<AgentSignal, AgentSignalRepositoryError>;
    /**
     * Take a signal another machine wrote. Applying it twice changes nothing:
     * a raise is kept once, and a closing lands only on an open signal of the
     * same seat. Answers the signal when this changed it, undefined when not.
     * `AgentSignalNotFound` for a closing of a signal this machine does not
     * hold and the sender may not raise.
     */
    readonly take: (
      input: TakenAgentSignal,
    ) => Effect.Effect<AgentSignal | undefined, AgentSignalRepositoryError>;
    /**
     * A file a signal attached, now judged from its bytes here: every part of
     * the signal naming that object is recorded as `mediaType`. Answers the
     * signal when this changed it, undefined when not.
     */
    readonly judgeFile: (
      signalId: string,
      object: Pick<ContentRef, "sha256" | "byteLength">,
      mediaType: string,
    ) => Effect.Effect<AgentSignal | undefined, AgentSignalRepositoryError>;
    /**
     * A seat's answered signals by when they were answered, not raised: from
     * `fromMs` on, or every one when absent. Uncapped; seat since reads it.
     */
    readonly listSeatAnswered: (
      seat: AgentSignalSeat,
      fromMs?: number,
    ) => Effect.Effect<ReadonlyArray<AgentSignal>, AgentSignalRepositoryError>;
  }>()("@junto/AgentSignalRepository") {}

const SignalRow = Schema.Struct({
  signal_id: Schema.String,
  canvas_name: Schema.String,
  node_id: Schema.String,
  kind: AgentSignalKind,
  text: Schema.String,
  detail: Schema.NullOr(Schema.String),
  source_json: Schema.NullOr(Schema.String),
  work_json: Schema.NullOr(Schema.String),
  form_json: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  state: AgentSignalState,
  response_text: Schema.NullOr(Schema.String),
  response_at: Schema.NullOr(Schema.Number),
  closed_at: Schema.NullOr(Schema.Number),
  attachments_json: Schema.String,
  suggestions_json: Schema.String,
  answer_files_json: Schema.String,
  answer_reply_json: Schema.NullOr(Schema.String),
});

/**
 * The part kind the operator's answer files are stored as, behind the seat's
 * own parts; its body is the file's reference. A build that does not know it
 * leaves it out, so it needs no migration.
 */
const ANSWER_FILE_PART_KIND = "answer-file";

/**
 * What a work reply left on the answer: the document it made (names only) or
 * the addresses its proof carries. A value never rides here; the vault holds
 * a secret's. Stored as its own part, so a build that does not know the kind
 * leaves it out, and read back onto the response.
 */
export type SignalReplyRecord =
  | { readonly kind: "artifact"; readonly nodeId: string; readonly artifactId: string; readonly title: string; readonly words: number }
  | { readonly kind: "links"; readonly links: ReadonlyArray<string> }
  /** A vault write's record: names only, never the value (0.12, N5). */
  | ({ readonly kind: "secret" } & SignalReplySecret);

const ANSWER_REPLY_PART_KIND = "answer-reply";

/**
 * A signal's columns, with its parts folded in three: what the operator can
 * open as `attachments_json`, the seat's pre-baked replies as
 * `suggestions_json`, and the operator's answer files as `answer_files_json`.
 * `from` names the row source the select reads signals from.
 */
const columnsOf = (from: string): string => `
  ${from}.signal_id, ${from}.canvas_name, ${from}.node_id, ${from}.kind, ${from}.text, ${from}.detail,
  ${from}.source_json, ${from}.work_json, ${from}.form_json,
  ${from}.created_at, ${from}.state, ${from}.response_text, ${from}.response_at, ${from}.closed_at,
  (
    SELECT json_group_array(json_object('kind', kind, 'body', json(body_json), 'caption', caption))
    FROM (
      SELECT * FROM agent_signal_parts
      WHERE agent_signal_parts.signal_id = ${from}.signal_id AND agent_signal_parts.kind <> 'suggest'
      ORDER BY position
    )
  ) AS attachments_json,
  (
    SELECT json_group_array(json_extract(body_json, '$.text'))
    FROM (
      SELECT * FROM agent_signal_parts
      WHERE agent_signal_parts.signal_id = ${from}.signal_id AND agent_signal_parts.kind = 'suggest'
      ORDER BY position
    )
  ) AS suggestions_json,
  (
    SELECT json_group_array(json(body_json))
    FROM (
      SELECT * FROM agent_signal_parts
      WHERE agent_signal_parts.signal_id = ${from}.signal_id AND agent_signal_parts.kind = '${ANSWER_FILE_PART_KIND}'
      ORDER BY position
    )
  ) AS answer_files_json,
  (
    SELECT json(body_json)
    FROM agent_signal_parts
    WHERE agent_signal_parts.signal_id = ${from}.signal_id AND agent_signal_parts.kind = '${ANSWER_REPLY_PART_KIND}'
    LIMIT 1
  ) AS answer_reply_json
`;
const COLUMNS = columnsOf("agent_signals");

/** Written only by `answer` below, from refs main claimed. */
const answerFilesOf = (json: string): ReadonlyArray<ContentRef> => JSON.parse(json) as ReadonlyArray<ContentRef>;

/**
 * The reply a work form's answer left: its document, its proof's addresses, or
 * the names a secret went to. A secret's value is never part of this record.
 */
const replyOf = (
  json: string | null,
): { readonly artifact?: SignalReplyArtifact; readonly links?: ReadonlyArray<string>; readonly secret?: SignalReplySecret } => {
  if (json === null) return {};
  const decoded = Schema.decodeUnknownOption(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("artifact"), nodeId: Schema.String, artifactId: Schema.String, title: Schema.String, words: Schema.Number }),
    Schema.Struct({ kind: Schema.Literal("links"), links: Schema.Array(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal("secret"), ...SignalReplySecret.fields }),
  ]))(JSON.parse(json));
  if (Option.isNone(decoded)) return {};
  const record = decoded.value;
  switch (record.kind) {
    case "artifact":
      return { artifact: { nodeId: asNodeId(record.nodeId), artifactId: ItemId.make(record.artifactId), title: record.title, words: record.words } };
    case "links":
      return { links: record.links };
    case "secret":
      return { secret: { item: record.item, name: record.name, regionId: record.regionId, machine: record.machine, setAt: record.setAt } };
  }
};

type PartJson = {
  readonly kind: string;
  readonly body: Record<string, unknown>;
  readonly caption: string | null;
};

/** Every attachment kind the wire knows: a new one fails to compile here until it is stored. */
const STORED_KINDS = {
  file: true,
  compare: true,
  commit: true,
  link: true,
  task: true,
  artifact: true,
} as const satisfies Record<AgentSignalAttachmentKind, true>;
const PART_KINDS: ReadonlySet<string> = new Set(Object.keys(STORED_KINDS));
/** The part kind a suggested reply is stored as; its body is `{"text": ...}`. */
const SUGGEST_PART_KIND = "suggest";

// Written only by `raise` below, from values the wire schema already holds.
// A part of a kind this build does not know is left out, not guessed at.
const attachmentsOf = (json: string): ReadonlyArray<AgentSignalAttachment> =>
  (JSON.parse(json) as ReadonlyArray<PartJson>)
    .filter((row) => PART_KINDS.has(row.kind))
    .map(
      (row) =>
        ({
          ...(row.kind === "file" ? { ref: row.body } : { kind: row.kind, ...row.body }),
          ...(row.caption === null ? {} : { caption: row.caption }),
        }) as unknown as AgentSignalAttachment,
    );

/** A part's kind and body as stored: a file's body is its reference, any other kind's is its own fields. */
const partOf = (attachment: AgentSignalAttachment): { readonly kind: string; readonly body: string } => {
  if (!("kind" in attachment)) {
    const { ref } = attachment;
    return {
      kind: "file",
      body: JSON.stringify({
        sha256: ref.sha256,
        byteLength: ref.byteLength,
        mediaType: ref.mediaType,
        displayName: ref.displayName ?? "file",
      }),
    };
  }
  const { kind, caption: _caption, ...body } = attachment;
  return { kind, body: JSON.stringify(body) };
};

const withAttachments = (json: string): { readonly attachments?: ReadonlyArray<AgentSignalAttachment> } => {
  const attachments = attachmentsOf(json);
  return attachments.length > 0 ? { attachments } : {};
};

const suggestionsOf = (json: string): ReadonlyArray<string> =>
  (JSON.parse(json) as ReadonlyArray<unknown>).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );

const withSuggestions = (json: string): { readonly suggestions?: ReadonlyArray<string> } => {
  const suggestions = suggestionsOf(json);
  return suggestions.length > 0 ? { suggestions } : {};
};

/** A signal's own fields as its column holds them: one JSON object, or null. */
const jsonOf = (value: object | undefined): string | null => (value === undefined ? null : JSON.stringify(value));

/** A column this build cannot read as its schema is left out, never guessed at. */
const claimed = <A, I>(schema: Schema.Codec<A, I, never, never>, json: string | null): A | undefined => {
  if (json === null) return undefined;
  const decoded = Schema.decodeUnknownOption(schema)(JSON.parse(json) as I);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const fromRow = (row: typeof SignalRow.Type): AgentSignal => {
  const source = claimed(SignalSourceSchema, row.source_json);
  const work = claimed(WorkTimingSchema, row.work_json);
  const form = claimed(SignalFormSchema, row.form_json);
  return {
    signalId: row.signal_id,
    canvasName: row.canvas_name,
    nodeId: row.node_id,
    kind: row.kind,
    text: row.text,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(source === undefined ? {} : { source }),
    ...(work === undefined ? {} : { work }),
    ...(form === undefined ? {} : { form }),
    ...withAttachments(row.attachments_json),
    ...withSuggestions(row.suggestions_json),
    createdAt: Number(row.created_at),
    state: row.state,
    ...(row.response_text === null || row.response_at === null
      ? {}
      : {
          response: {
            text: row.response_text,
            at: Number(row.response_at),
            ...(answerFilesOf(row.answer_files_json).length > 0 ? { attachments: answerFilesOf(row.answer_files_json) } : {}),
            ...replyOf(row.answer_reply_json),
          },
        }),
    ...(row.closed_at === null ? {} : { closedAt: Number(row.closed_at) }),
  };
};

const notFound = (signalId: string, message: string) =>
  AgentSignalNotFound.make({ signalId, message });

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | AgentSignalNotFound) =>
  error instanceof AgentSignalNotFound
    ? error
    : AgentSignalPersistenceError.make({
        operation,
        message: error.message,
        cause: error,
      });

export const AgentSignalRepositoryLive: Layer.Layer<
  AgentSignalRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  AgentSignalRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Union([Schema.Number, Schema.BigInt]) }));
    const oneRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SignalRow,
      execute: (signalId) => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals WHERE signal_id = ?`, [signalId]),
    });
    const readOne = Effect.fn("agent-signals.read-one")(function* (signalId: string) {
      const row = yield* oneRow(signalId);
      return row._tag === "None" ? undefined : fromRow(row.value);
    });
    const openSeatRows = SqlSchema.findAll({
      Request: Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String }),
      Result: SignalRow,
      execute: (seat) => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals
        WHERE canvas_name = ? AND node_id = ? AND state = 'open'`, [seat.canvasName, seat.nodeId]),
    });
    // Open first (newest first), then the newest closed history per seat.
    const listRows = SqlSchema.findAll({
      Request: Schema.Tuple([Schema.String, Schema.Array(Schema.String)]),
      Result: SignalRow,
      execute: ([where, bindings]) => sql.unsafe(`
        SELECT ${columnsOf("ranked")} FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY canvas_name, node_id, state = 'open'
            ORDER BY created_at DESC, signal_id DESC
          ) AS seat_rank
          FROM agent_signals WHERE ${where}
        ) AS ranked
        WHERE state = 'open' OR seat_rank <= ${AGENT_SIGNAL_CLOSED_HISTORY}
        ORDER BY state <> 'open', created_at DESC, signal_id DESC
      `, bindings),
    });
    // Open signals, and every closed one from the cursor on, uncapped.
    const sinceRows = SqlSchema.findAll({
      Request: Schema.Tuple([Schema.String, Schema.String, Schema.Union([Schema.String, Schema.Number])]),
      Result: SignalRow,
      execute: ([canvasName, nodeId, from]) => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals
        WHERE canvas_name = ? AND node_id = ?
          AND (state = 'open' OR ${typeof from === "string" ? "signal_id > ?" : "created_at >= ?"})
        ORDER BY state <> 'open', created_at DESC, signal_id DESC`, [canvasName, nodeId, from]),
    });
    const closedCountRows = SqlSchema.findAll({
      Request: Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String }),
      Result: Schema.Struct({ closed: Schema.Union([Schema.Number, Schema.BigInt]) }),
      execute: (seat) => sql.unsafe(`SELECT COUNT(*) AS closed FROM agent_signals
        WHERE canvas_name = ? AND node_id = ? AND state <> 'open'`, [seat.canvasName, seat.nodeId]),
    });
    const raisedHandsRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SignalRow,
      execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals
        WHERE state = 'open' AND kind IN ('blocked', 'escalate')`),
    });

    const raise = Effect.fn("agent-signals.raise")(function* (input: RaiseAgentSignal) {
      const signalId = input.signalId ?? ulid();
      yield* sql`
        INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, detail, source_json, work_json, form_json, created_at, state)
        VALUES (${signalId}, ${input.canvasName}, ${input.nodeId}, ${input.kind}, ${input.text}, ${input.detail ?? null},
          ${jsonOf(input.source)}, ${jsonOf(input.work)}, ${jsonOf(input.form)}, ${Date.now()}, 'open')
      `;
      for (const [position, attachment] of (input.attachments ?? []).entries()) {
        const part = partOf(attachment);
        yield* sql`
          INSERT INTO agent_signal_parts(signal_id, position, kind, body_json, caption)
          VALUES (${signalId}, ${position}, ${part.kind}, ${part.body}, ${attachment.caption ?? null})
        `;
      }
      // Pre-baked replies ride as parts behind the attachments, in order.
      const offset = input.attachments?.length ?? 0;
      for (const [index, suggestion] of (input.suggestions ?? []).entries()) {
        yield* sql`
          INSERT INTO agent_signal_parts(signal_id, position, kind, body_json)
          VALUES (${signalId}, ${offset + index}, ${SUGGEST_PART_KIND}, ${JSON.stringify({ text: suggestion })})
        `;
      }
      return (yield* readOne(signalId))!;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-signals.raise"),
    Effect.mapError(persistence("raise")));

    const withdraw = Effect.fn("agent-signals.withdraw")(function* (seat: AgentSignalSeat, signalId?: string) {
      const ids = signalId === undefined
        ? (yield* openSeatRows(seat)).map((row) => row.signal_id)
        : [signalId];
      const now = Date.now();
      for (const id of ids) {
        const changed = yield* sql`
          UPDATE agent_signals SET state = 'withdrawn', closed_at = ${now}
          WHERE signal_id = ${id} AND canvas_name = ${seat.canvasName} AND node_id = ${seat.nodeId} AND state = 'open'
        `.raw.pipe(Effect.flatMap(changes));
        if (Number(changed.changes) === 0) {
          return yield* notFound(id, `signal ${id} is not an open signal of this seat`);
        }
      }
      return yield* Effect.forEach(ids, (id) => readOne(id).pipe(Effect.map((signal) => signal!)));
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-signals.withdraw"),
    Effect.mapError(persistence("withdraw")));

    const listSeat = Effect.fn("agent-signals.list-seat")(function* (seat: AgentSignalSeat, since?: SignalSinceCursor) {
      const rows = since === undefined
        ? yield* listRows(["canvas_name = ? AND node_id = ?", [seat.canvasName, seat.nodeId]])
        : yield* sinceRows([seat.canvasName, seat.nodeId, "afterId" in since ? since.afterId : since.fromMs]);
      return rows.map(fromRow);
    }, Effect.mapError(persistence("list seat")));

    const countClosedSeat = Effect.fn("agent-signals.count-closed-seat")(function* (seat: AgentSignalSeat) {
      return Number((yield* closedCountRows(seat))[0]?.closed ?? 0);
    }, Effect.mapError(persistence("count closed seat")));

    const listCanvas = Effect.fn("agent-signals.list-canvas")(function* (canvasName: string) {
      return (yield* listRows(["canvas_name = ?", [canvasName]])).map(fromRow);
    }, Effect.mapError(persistence("list canvas")));

    const listRaisedHands = Effect.fn("agent-signals.list-raised-hands")(function* () {
      return (yield* raisedHandsRows(undefined)).map(fromRow);
    }, Effect.mapError(persistence("list raised hands")))();

    const get = Effect.fn("agent-signals.get")(function* (signalId: string) {
      const signal = yield* readOne(signalId);
      if (!signal) return yield* notFound(signalId, `no signal ${signalId}`);
      return signal;
    }, Effect.mapError(persistence("get")));

    const answeredRows = SqlSchema.findAll({
      Request: Schema.Tuple([Schema.String, Schema.String, Schema.Number]),
      Result: SignalRow,
      execute: ([canvasName, nodeId, fromMs]) => sql.unsafe(`SELECT ${COLUMNS} FROM agent_signals
        WHERE canvas_name = ? AND node_id = ? AND state = 'answered' AND response_at >= ?
        ORDER BY response_at DESC, signal_id DESC`, [canvasName, nodeId, fromMs]),
    });
    const listSeatAnswered = Effect.fn("agent-signals.list-seat-answered")(function* (seat: AgentSignalSeat, fromMs?: number) {
      return (yield* answeredRows([seat.canvasName, seat.nodeId, fromMs ?? 0])).map(fromRow);
    }, Effect.mapError(persistence("list seat answered")));

    const close = Effect.fn("agent-signals.close")(function* (
      operation: string,
      signalId: string,
      query: string,
      bindings: ReadonlyArray<string | number>,
    ) {
      const changed = yield* sql.unsafe(query, bindings).raw.pipe(Effect.flatMap(changes));
      if (Number(changed.changes) === 0) {
        return yield* notFound(signalId, `signal ${signalId} is not open`);
      }
      return (yield* readOne(signalId))!;
    }, sql.withTransaction, (effect, operation) => effect.pipe(
      Effect.provideService(StateTransactionOperation, `agent-signals.${operation}`),
      Effect.mapError(persistence(operation)),
    ));

    const answer = Effect.fn("agent-signals.answer")(function* (
      signalId: string,
      text: string,
      files: ReadonlyArray<ContentRef> = [],
      reply?: SignalReplyRecord,
    ) {
      const now = Date.now();
      const changed = yield* sql`
        UPDATE agent_signals
        SET state = 'answered', response_text = ${text}, response_at = ${now}, closed_at = ${now}
        WHERE signal_id = ${signalId} AND state = 'open'
      `.raw.pipe(Effect.flatMap(changes));
      if (Number(changed.changes) === 0) {
        return yield* notFound(signalId, `signal ${signalId} is not open`);
      }
      // The operator's files ride as parts behind the seat's own, in order.
      const [after] = yield* sql<{ readonly next: number }>`
        SELECT COALESCE(MAX(position) + 1, 0) AS next FROM agent_signal_parts WHERE signal_id = ${signalId}
      `;
      for (const [index, ref] of files.entries()) {
        const body = JSON.stringify({
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          mediaType: ref.mediaType,
          displayName: ref.displayName ?? "file",
        });
        yield* sql`
          INSERT INTO agent_signal_parts(signal_id, position, kind, body_json)
          VALUES (${signalId}, ${Number(after?.next ?? 0) + index}, ${ANSWER_FILE_PART_KIND}, ${body})
        `;
      }
      if (reply !== undefined) {
        yield* sql`
          INSERT INTO agent_signal_parts(signal_id, position, kind, body_json)
          VALUES (${signalId}, ${Number(after?.next ?? 0) + files.length}, ${ANSWER_REPLY_PART_KIND}, ${JSON.stringify(reply)})
        `;
      }
      return (yield* readOne(signalId))!;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-signals.answer"),
    Effect.mapError(persistence("answer")));

    const dismiss = (signalId: string) =>
      close(
        "dismiss",
        signalId,
        `
          UPDATE agent_signals
          SET state = 'dismissed', closed_at = ?
          WHERE signal_id = ? AND state = 'open'
        `,
        [Date.now(), signalId],
      );

    const takeRow = Effect.fn("agent-signals.take")(function* (input: TakenAgentSignal) {
      let changed = false;
      const held = yield* readOne(input.signalId);
      if (held === undefined) {
        if (!input.raises) return yield* notFound(input.signalId, `no signal ${input.signalId} to close`);
        yield* sql`
          INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, detail, source_json, work_json, form_json, created_at, state)
          VALUES (${input.signalId}, ${input.canvasName}, ${input.nodeId}, ${input.kind}, ${input.text}, ${input.detail ?? null},
            ${jsonOf(input.source)}, ${jsonOf(input.work)}, ${jsonOf(input.form)}, ${input.createdAt}, 'open')
        `;
        // What it attached lands as parts by reference, then the suggestions behind them, as a raise stores them.
        for (const [position, attachment] of (input.attachments ?? []).entries()) {
          const part = partOf(attachment);
          yield* sql`
            INSERT INTO agent_signal_parts(signal_id, position, kind, body_json, caption)
            VALUES (${input.signalId}, ${position}, ${part.kind}, ${part.body}, ${attachment.caption ?? null})
          `;
        }
        const offset = input.attachments?.length ?? 0;
        for (const [index, suggestion] of (input.suggestions ?? []).entries()) {
          yield* sql`
            INSERT INTO agent_signal_parts(signal_id, position, kind, body_json)
            VALUES (${input.signalId}, ${offset + index}, ${SUGGEST_PART_KIND}, ${JSON.stringify({ text: suggestion })})
          `;
        }
        changed = true;
      } else if (held.canvasName !== input.canvasName || held.nodeId !== input.nodeId) {
        return yield* notFound(input.signalId, `signal ${input.signalId} belongs to another seat`);
      }
      const closing = input.closing;
      if (closing !== undefined) {
        const response = closing.state === "answered" ? closing.response : undefined;
        const closed = yield* sql`
          UPDATE agent_signals
          SET state = ${closing.state}, closed_at = ${closing.closedAt},
              response_text = ${response?.text ?? null}, response_at = ${response?.at ?? null}
          WHERE signal_id = ${input.signalId} AND state = 'open'
        `.raw.pipe(Effect.flatMap(changes));
        changed = changed || Number(closed.changes) > 0;
      }
      return changed ? yield* readOne(input.signalId) : undefined;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-signals.take"),
    Effect.mapError(persistence("take")));

    const judgeFileRow = Effect.fn("agent-signals.judge-file")(function* (
      signalId: string,
      object: Pick<ContentRef, "sha256" | "byteLength">,
      mediaType: string,
    ) {
      // A file's body is its ref; a compare's two sides are refs at before and after.
      let changed = 0;
      for (const path of ["$", "$.before", "$.after"] as const) {
        const updated = yield* sql`
          UPDATE agent_signal_parts
          SET body_json = json_set(body_json, ${`${path}.mediaType`}, ${mediaType})
          WHERE signal_id = ${signalId}
            AND kind = ${path === "$" ? "file" : "compare"}
            AND json_extract(body_json, ${`${path}.sha256`}) = ${object.sha256}
            AND json_extract(body_json, ${`${path}.byteLength`}) = ${object.byteLength}
            AND json_extract(body_json, ${`${path}.mediaType`}) IS NOT ${mediaType}
        `.raw.pipe(Effect.flatMap(changes));
        changed += Number(updated.changes);
      }
      return changed > 0 ? yield* readOne(signalId) : undefined;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-signals.judge-file"),
    Effect.mapError(persistence("judge-file")));

    // Listeners hear of a write once it is committed, never from inside it.
    const told = <E, R>(write: Effect.Effect<AgentSignal, E, R>) =>
      write.pipe(Effect.tap((signal) => Effect.sync(() => emitAgentSignalChanged(signal))));

    return AgentSignalRepository.of({
      raise: (input) => told(raise(input)),
      withdraw: (seat, signalId) =>
        withdraw(seat, signalId).pipe(
          Effect.tap((signals) => Effect.sync(() => signals.forEach(emitAgentSignalChanged))),
        ),
      listSeat,
      countClosedSeat,
      listRaisedHands,
      listCanvas,
      get,
      answer: (signalId, text, files, reply) => told(answer(signalId, text, files, reply)),
      dismiss: (signalId) => told(dismiss(signalId)),
      take: (input) =>
        takeRow(input).pipe(
          Effect.tap((signal) => Effect.sync(() => (signal === undefined ? undefined : emitAgentSignalChanged(signal)))),
        ),
      judgeFile: (signalId, object, mediaType) =>
        judgeFileRow(signalId, object, mediaType).pipe(
          Effect.tap((signal) => Effect.sync(() => (signal === undefined ? undefined : emitAgentSignalChanged(signal)))),
        ),
      listSeatAnswered,
    });
  }),
);
