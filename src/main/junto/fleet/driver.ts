/**
 * The driver of one canvas's consensus group (0.11, 06 F2): it holds the pure
 * core (`consensus.ts`) and does its I/O in the order `ready()` asks, against
 * the tables of state step 61 (`state-schema.ts`).
 *
 * Each `ready()` is two transactions:
 *
 * 1. **Persist**, under `synchronous=FULL`: the hard state (term, vote,
 *    commit), the truncated tail and the new entries. Raft's acknowledgement
 *    is this write, so it is durable before any message leaves.
 * 2. **Apply**: every committed entry above `applied_index`, in index order,
 *    and the new `applied_index`, in one transaction. A ruling is folded
 *    through `foldRuling` with what the judgment kept, and only then is its
 *    row recorded, as the ruler does (the row stands on the count a placement
 *    moved). The fold is not idempotent (a body's content ref is drawn fresh,
 *    the canvas count moves), so an entry is applied exactly once: a failure
 *    anywhere in the apply rolls back its folds with the index, and the
 *    driver must be opened again.
 *
 * Opening reads the persisted state, applies whatever was committed and not
 * applied (a crash between the two transactions), and then hands the core its
 * log: the core counts everything committed as applied. A canvas with no row
 * yet starts as the migration seeded every canvas: term 1, its editor (this
 * machine where none is named) its one authority. Entry 1 is that list,
 * committed, as every member of a new group starts.
 *
 * Messages are the caller's to send; a canvas this machine rules alone needs
 * none, and settles its own election when opened.
 */
import { Context, Effect, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ArtifactBody } from "@shared/artifact";
import { rulingRowOf } from "@shared/command-row";
import type { InstallationId } from "@shared/installation-id";
import type { ResourceCommand } from "@shared/resource-command";
import { RulingRecorder, type RulingRecordFailed } from "../work/ruling-recorder";
import { RulingCapture, type RecordRulingInput } from "../work/repository";
import { foldRuling } from "../work/ruling-projection";
import { ConsensusNode, ProposalRefused, type Entry, type EntryPayload, type HardState, type MemberList, type Message, type Ready, type Status } from "./consensus";

export class FleetDriverError extends Schema.TaggedError<FleetDriverError>()("FleetDriverError", {
  message: Schema.String,
  cause: Schema.Unknown,
  /** The command is still to rule: the caller keeps it queued and sends it again. */
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

/** A judged ruling as the log carries it: what the recorder takes, the bodies the judgment kept, and when it was judged. */
export type LoggedRuling = {
  readonly input: Omit<RecordRulingInput, "bodies" | "placement">;
  readonly bodies: ReadonlyArray<{ readonly sha256: string; readonly body: ArtifactBody }>;
  readonly ruledAt: number;
};

/** What a data entry carries. A structure change folds in F4; until then it only moves the index. */
export type LogData =
  | { readonly kind: "ruling"; readonly ruling: LoggedRuling }
  | { readonly kind: "structure.changed"; readonly seq: number };

const LoggedRulingSchema = Schema.Struct({
  input: Schema.Struct({
    canvasName: Schema.String,
    writer: Schema.String,
    command: Schema.Struct({ opId: Schema.String, actor: Schema.Unknown, target: Schema.Unknown }),
    kind: Schema.Literals(["task", "artifact", "thread", "automation"]),
    record: Schema.Unknown,
    ruling: Schema.Unknown,
    at: Schema.optionalKey(Schema.String),
  }),
  bodies: Schema.Array(Schema.Struct({ sha256: Schema.String, body: ArtifactBody })),
  ruledAt: Schema.Number,
});
const LogDataSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ruling"), ruling: LoggedRulingSchema }),
  Schema.Struct({ kind: Schema.Literal("structure.changed"), seq: Schema.Number }),
]);
const decodeLogData = Schema.decodeUnknownResult(Schema.fromJsonString(LogDataSchema));

export const encodeLogData = (data: LogData): string => JSON.stringify(data);

/** A judged ruling, ready to propose: the recorder's input with the bodies its judgment kept. */
export const loggedRuling = (input: RecordRulingInput, ruledAt: number): LoggedRuling => {
  const { bodies, placement: _placement, ...rest } = input;
  return { input: rest, bodies: [...(bodies ?? new Map()).entries()].map(([sha256, body]) => ({ sha256, body })), ruledAt };
};

const failed = (message: string) => (cause: unknown) => new FleetDriverError({ message, cause });

const dataOf = (payload: Extract<EntryPayload, { kind: "data" }>): Effect.Effect<LogData, FleetDriverError> => {
  const decoded = decodeLogData(payload.data);
  return decoded._tag === "Failure"
    ? Effect.fail(new FleetDriverError({ message: "a log entry carries data this build does not know", cause: decoded.failure }))
    : Effect.succeed(decoded.success as LogData);
};

type RecordRuling = (input: RecordRulingInput) => Effect.Effect<void, RulingRecordFailed>;

type ConsensusRow = {
  readonly current_term: number;
  readonly voted_for: string | null;
  readonly commit_index: number;
  readonly applied_index: number;
};

type LogRow = {
  readonly log_index: number;
  readonly term: number;
  readonly kind: "noop" | "list" | "ruling" | "structure.changed";
  readonly writer: string | null;
  readonly command_json: string | null;
  readonly ruling_json: string | null;
  readonly structure_seq: number | null;
  readonly sole_installation_id: string | null;
};

type MemberRow = { readonly log_index: number; readonly side: "list" | "old"; readonly installation_id: string };

/** The ruling columns of a log row, and back: the command and the rest, never the canvas (the row's key). */
const rulingColumns = (ruling: LoggedRuling) => {
  const { command, writer, canvasName: _canvasName, ...rest } = ruling.input;
  return {
    writer,
    opId: command.opId,
    commandJson: JSON.stringify(command),
    rulingJson: JSON.stringify({ ...rest, bodies: ruling.bodies, ruledAt: ruling.ruledAt }),
  };
};

const payloadOf = (canvasName: string, row: LogRow, members: ReadonlyArray<MemberRow>): EntryPayload => {
  switch (row.kind) {
    case "noop":
      return { kind: "noop" };
    case "list": {
      const side = (name: "list" | "old") => members.filter((member) => member.side === name).map((member) => member.installation_id);
      const old = side("old");
      return {
        kind: "list",
        members: {
          list: side("list"),
          ...(old.length > 0 ? { old } : {}),
          ...(row.sole_installation_id === null ? {} : { sole: row.sole_installation_id }),
        },
      };
    }
    case "ruling": {
      const rest = JSON.parse(row.ruling_json!) as Record<string, unknown>;
      const { bodies, ruledAt, ...input } = rest;
      const data: LogData = {
        kind: "ruling",
        ruling: {
          input: { ...input, canvasName, writer: row.writer, command: JSON.parse(row.command_json!) } as never,
          bodies: bodies as never,
          ruledAt: ruledAt as number,
        },
      };
      return { kind: "data", data: encodeLogData(data) };
    }
    case "structure.changed":
      return { kind: "data", data: encodeLogData({ kind: "structure.changed", seq: row.structure_seq! }) };
  }
};

const writeEntry = (sql: SqlClient.SqlClient, canvasName: string, entry: Entry) =>
  Effect.gen(function* () {
    const { payload } = entry;
    if (payload.kind === "data") {
      const data = yield* dataOf(payload);
      if (data.kind === "ruling") {
        const columns = rulingColumns(data.ruling);
        yield* sql`INSERT INTO canvas_log (canvas_name, log_index, term, kind, writer, op_id, command_json, ruling_json)
          VALUES (${canvasName}, ${entry.index}, ${entry.term}, 'ruling', ${columns.writer}, ${columns.opId}, ${columns.commandJson}, ${columns.rulingJson})`;
      } else {
        yield* sql`INSERT INTO canvas_log (canvas_name, log_index, term, kind, structure_seq)
          VALUES (${canvasName}, ${entry.index}, ${entry.term}, 'structure.changed', ${data.seq})`;
      }
      return;
    }
    if (payload.kind === "noop") {
      yield* sql`INSERT INTO canvas_log (canvas_name, log_index, term, kind) VALUES (${canvasName}, ${entry.index}, ${entry.term}, 'noop')`;
      return;
    }
    const { members } = payload;
    yield* sql`INSERT INTO canvas_log (canvas_name, log_index, term, kind, sole_installation_id)
      VALUES (${canvasName}, ${entry.index}, ${entry.term}, 'list', ${members.sole ?? null})`;
    for (const [side, ids] of [["list", members.list], ["old", members.old ?? []]] as const) {
      for (const [position, id] of ids.entries()) {
        yield* sql`INSERT INTO canvas_log_members (canvas_name, log_index, side, position, installation_id)
          VALUES (${canvasName}, ${entry.index}, ${side}, ${position}, ${id})`;
      }
    }
  });

/** A committed list: the final list becomes the canvas's authorities; a joint one waits in the log for its successor. */
const applyList = (sql: SqlClient.SqlClient, canvasName: string, members: MemberList) =>
  Effect.gen(function* () {
    if (members.old !== undefined) return;
    yield* sql`UPDATE canvas_consensus SET sole_installation_id = ${members.sole ?? null} WHERE canvas_name = ${canvasName}`;
    yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = ${canvasName}`;
    for (const [position, id] of members.list.entries()) {
      yield* sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES (${canvasName}, ${position}, ${id})`;
    }
  });

/** One committed entry, folded as the ruler would have written it: the facts, then the ruling row. */
const applyEntry = (sql: SqlClient.SqlClient, record: RecordRuling, canvasName: string, entry: Entry) =>
  Effect.gen(function* () {
    const { payload } = entry;
    if (payload.kind === "noop") return;
    if (payload.kind === "list") return yield* applyList(sql, canvasName, payload.members);
    const data = yield* dataOf(payload);
    if (data.kind === "structure.changed") return;
    const { input, bodies, ruledAt } = data.ruling;
    const ruled: RecordRulingInput = { ...input, bodies: new Map(bodies.map(({ sha256, body }) => [sha256, body])) };
    const row = rulingRowOf(ruled.writer, ruled.command, ruled.kind, ruled.ruling as never);
    if (row.operation === "ruling.applied") {
      yield* foldRuling(sql, canvasName, row, ruledAt, {
        bodies: ruled.bodies,
        command: ruled.command as Pick<ResourceCommand<unknown>, "op" | "target">,
      });
    }
    yield* record(ruled);
  });

const readConsensus = (sql: SqlClient.SqlClient, canvasName: string) =>
  Effect.map(
    sql<ConsensusRow>`SELECT current_term, voted_for, commit_index, applied_index FROM canvas_consensus WHERE canvas_name = ${canvasName}`,
    (rows) => rows[0],
  );

const readLog = (sql: SqlClient.SqlClient, canvasName: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<LogRow>`
      SELECT log_index, term, kind, writer, command_json, ruling_json, structure_seq, sole_installation_id
      FROM canvas_log WHERE canvas_name = ${canvasName} ORDER BY log_index`;
    const members = yield* sql<MemberRow>`
      SELECT log_index, side, installation_id FROM canvas_log_members
      WHERE canvas_name = ${canvasName} ORDER BY log_index, side, position`;
    return rows.map((row): Entry => ({
      term: row.term,
      index: row.log_index,
      payload: payloadOf(canvasName, row, members.filter((member) => member.log_index === row.log_index)),
    }));
  });

/**
 * A canvas from before its first entry: the row the migration would have
 * seeded, and entry 1 its list, committed and applied (as the simulation's
 * genesis). Every member writes the same entry 1 from the same list.
 */
const bootstrap = (sql: SqlClient.SqlClient, canvasName: string, self: InstallationId) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO canvas_consensus (canvas_name, current_term, voted_for, commit_index, applied_index)
      VALUES (${canvasName}, 1, NULL, 0, 0) ON CONFLICT (canvas_name) DO NOTHING`;
    const held = yield* sql<{ installation_id: string }>`
      SELECT installation_id FROM canvas_authorities WHERE canvas_name = ${canvasName} ORDER BY position`;
    // Entry 1 is F6's list, never a guess: two machines guessing differently would write two entries at (1,1).
    if (held.length === 0) {
      return yield* Effect.fail(new FleetDriverError({
        message: `${canvasName} has no authority list to begin its log from`,
        cause: { canvasName, self },
      }));
    }
    const list = held.map((row) => row.installation_id);
    const sole = (yield* sql<{ sole: string | null }>`SELECT sole_installation_id AS sole FROM canvas_consensus WHERE canvas_name = ${canvasName}`)[0]?.sole;
    const members: MemberList = { list, ...(sole === null || sole === undefined ? {} : { sole }) };
    yield* writeEntry(sql, canvasName, { term: 1, index: 1, payload: { kind: "list", members } });
    yield* applyList(sql, canvasName, members);
    yield* sql`UPDATE canvas_consensus SET commit_index = 1, applied_index = 1 WHERE canvas_name = ${canvasName}`;
  });

/**
 * The canvas whose batch this fiber is judging. The FULL lock is not
 * reentrant, so a batch that reached any canvas's judge would wait on itself:
 * it is refused before it takes a lock.
 */
const Judging = Context.Reference<string | undefined>("@junto/FleetJudging", { defaultValue: () => undefined });

/**
 * One consensus transaction at a time in this process. `synchronous` is the
 * connection's, set and reset around a transaction as separate statements:
 * without one holder across all three, a second canvas's reset to NORMAL can
 * land while the first's transaction is still to commit.
 */
const durableLock = Semaphore.makeUnsafe(1);

/**
 * A consensus transaction: its acknowledgement survives power loss, so it
 * commits under synchronous=FULL. `beforeBegin` runs between setting FULL and
 * BEGIN, the gap a second canvas would race into; only tests pass it.
 */
export const durableTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  transaction: Effect.Effect<A, E, R>,
  beforeBegin: Effect.Effect<void> = Effect.void,
) =>
  durableLock.withPermits(1)(
    sql`PRAGMA synchronous = FULL`.pipe(
      Effect.andThen(beforeBegin),
      Effect.andThen(sql.withTransaction(transaction)),
      Effect.ensuring(Effect.ignore(sql`PRAGMA synchronous = NORMAL`)),
    ),
  );

export type CanvasAuthorityOptions = {
  readonly canvasName: string;
  readonly self: InstallationId;
  readonly electionTicks?: number;
  readonly heartbeatTicks?: number;
  /** Runs between persisting a drain and applying what it committed; only tests pass it, to hold that gap open. */
  readonly beforeApply?: Effect.Effect<void>;
};

/** A judged batch: what the rulers answered, and the entries their rulings became, all applied. */
export type Judgment<A> = {
  readonly value: A;
  readonly entries: ReadonlyArray<Entry>;
  readonly messages: ReadonlyArray<Message>;
};

/** A batch's answer, carried out of the savepoint that rolls its judgment back. */
class Judged<A> {
  readonly _tag = "Judged";
  constructor(readonly value: A) {}
}

export type CanvasAuthority = {
  readonly status: () => Status;
  /**
   * Judge a batch of commands (0.11, 06 F2, steps 1 to 3): in one
   * transaction, the rulers run unchanged in a savepoint that is rolled back,
   * keeping the rulings they record, and those are appended as entries with
   * this machine's acknowledgement. Then what committed is applied, and only
   * then is the batch's answer returned. One batch at a time per canvas.
   */
  readonly judge: <A, E, R>(batch: Effect.Effect<A, E, R>) => Effect.Effect<Judgment<A>, E | FleetDriverError, R>;
  /** Propose an entry (a judged ruling, a structure change); on a canvas this machine rules alone it is committed and applied when this returns. */
  readonly propose: (data: LogData) => Effect.Effect<Entry, FleetDriverError>;
  readonly tick: () => Effect.Effect<ReadonlyArray<Message>, FleetDriverError>;
  readonly step: (message: Message) => Effect.Effect<ReadonlyArray<Message>, FleetDriverError>;
  /** `junto authority alone`: the operator says the pair's other machine is dead; this one becomes sole voter. */
  readonly alone: () => Effect.Effect<ReadonlyArray<Message>, FleetDriverError>;
};

/** Open a canvas's group on this machine: load it, apply what was committed and not applied, and settle a lone authority. */
export const openCanvasAuthority = (
  options: CanvasAuthorityOptions,
): Effect.Effect<CanvasAuthority, FleetDriverError, SqlClient.SqlClient | RulingRecorder> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const recorder = yield* RulingRecorder;
    const { canvasName, self } = options;
    const electionTicks = options.electionTicks ?? 10;

    const apply = (entries: ReadonlyArray<Entry>, through: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const applied = (yield* readConsensus(sql, canvasName))?.applied_index ?? 0;
          let last = applied;
          for (const entry of entries) {
            if (entry.index <= last) continue;
            yield* applyEntry(sql, recorder.record, canvasName, entry);
            last = entry.index;
          }
          if (through > applied) {
            yield* sql`UPDATE canvas_consensus SET applied_index = ${through}, last_applied_at_epoch_ms = ${Date.now()}
              WHERE canvas_name = ${canvasName}`;
          }
        }),
      );

    const loaded = yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM canvas_log WHERE canvas_name = ${canvasName}`)[0]!.n === 0) {
          yield* bootstrap(sql, canvasName, self);
        }
        return { consensus: (yield* readConsensus(sql, canvasName))!, log: yield* readLog(sql, canvasName) };
      }),
    ).pipe(Effect.mapError((cause) => (cause instanceof FleetDriverError ? cause : failed(`the authority of ${canvasName} could not be read`)(cause))));

    const { consensus, log } = loaded;
    // Committed and not applied: a crash came between persisting and applying. Applied now, once.
    if (consensus.commit_index > consensus.applied_index) {
      yield* apply(log.filter((entry) => entry.index <= consensus.commit_index), consensus.commit_index).pipe(
        Effect.mapError(failed(`the committed entries of ${canvasName} could not be applied`)),
      );
    }

    const hardState: HardState = { term: consensus.current_term, votedFor: consensus.voted_for, commit: consensus.commit_index };
    const node = new ConsensusNode({ id: self, electionTicks, heartbeatTicks: options.heartbeatTicks ?? 1, hardState, log });
    let broken: FleetDriverError | undefined;
    /**
     * One holder of this canvas's core at a time: mutate, take ready, persist
     * and apply as one step. A ready taken outside it can be stale by the time
     * it persists, deleting entries another holder just acknowledged; and
     * inside it commit equals applied whenever a batch is judged. The
     * process-wide FULL lock nests inside, never the other way.
     */
    const canvasLock = Semaphore.makeUnsafe(1);
    const exclusive = canvasLock.withPermits(1);

    /** The core refused before changing anything: not leader, a list pending, and the like; the caller sends again. */
    const refusal = (cause: unknown) =>
      new FleetDriverError({
        message: cause instanceof ProposalRefused ? `${canvasName} refused the proposal: ${cause.reason}` : `the authority of ${canvasName} refused`,
        cause,
        ...(cause instanceof ProposalRefused ? { retryable: true } : {}),
      });

    const isEmpty = (ready: Ready) => ready.hardState === undefined && ready.truncateFrom === undefined && ready.entries.length === 0;

    /** What `ready()` says to persist, inside the caller's transaction. */
    const writeReady = (ready: Ready) =>
      Effect.gen(function* () {
        if (ready.hardState !== undefined) {
          yield* sql`UPDATE canvas_consensus
            SET current_term = ${ready.hardState.term}, voted_for = ${ready.hardState.votedFor}, commit_index = ${ready.hardState.commit}
            WHERE canvas_name = ${canvasName}`;
        }
        const from = Math.min(ready.truncateFrom ?? Number.POSITIVE_INFINITY, ...ready.entries.map((entry) => entry.index));
        if (Number.isFinite(from)) yield* sql`DELETE FROM canvas_log WHERE canvas_name = ${canvasName} AND log_index >= ${from}`;
        for (const entry of ready.entries) yield* writeEntry(sql, canvasName, entry);
      });

    const durably = <A, E, R>(transaction: Effect.Effect<A, E, R>) => durableTransaction(sql, transaction);

    // The core ran ahead of what is on disk: only opening the canvas again tells it the truth.
    const breaks = (cause: unknown) => {
      broken = cause instanceof FleetDriverError ? cause : new FleetDriverError({ message: `the authority of ${canvasName} must be opened again`, cause });
      return broken;
    };

    const applyCommitted = (ready: Ready) =>
      ready.committed.length === 0 ? Effect.void : apply(ready.committed, ready.committed.at(-1)!.index);

    /**
     * An `alone` fork took entries this machine had applied: the history that
     * replaces them sits at indices it counts as applied, so applying on would
     * skip them and diverge. Until revoked entries wait for the operator, the
     * driver refuses instead, and persists nothing of this ready.
     */
    const unrevoked = (ready: Ready) =>
      ready.revoked.length === 0
        ? Effect.void
        : Effect.fail(breaks(new FleetDriverError({
          message: `an alone fork revoked ${ready.revoked.length} applied entries of ${canvasName}; the operator must settle them`,
          cause: ready.revoked.map((entry) => entry.index),
        })));

    /** Drain the core: persist, hand back the messages to send, then apply what committed. */
    const drain = Effect.suspend(() => {
      if (broken !== undefined) return Effect.fail(broken);
      const ready = node.ready();
      return Effect.gen(function* () {
        yield* unrevoked(ready);
        if (!isEmpty(ready)) yield* durably(writeReady(ready));
        if (ready.committed.length > 0 && options.beforeApply !== undefined) yield* options.beforeApply;
        yield* applyCommitted(ready);
        return ready.messages;
      }).pipe(Effect.mapError(breaks));
    });

    const judge = <A, E, R>(batch: Effect.Effect<A, E, R>): Effect.Effect<Judgment<A>, E | FleetDriverError, R> =>
      Effect.flatMap(Judging, (outer) => outer === undefined ? judgeAlone(batch) : Effect.fail(new FleetDriverError({
        message: `a batch for ${outer} reached the authority of ${canvasName}: a batch is judged by one canvas, and judges nothing itself`,
        cause: { outer, canvasName },
      })));

    const judgeAlone = <A, E, R>(batch: Effect.Effect<A, E, R>): Effect.Effect<Judgment<A>, E | FleetDriverError, R> =>
      exclusive(Effect.suspend(() => {
        if (broken !== undefined) return Effect.fail(broken);
        const status = node.status();
        if (!status.canCommit) {
          return Effect.fail(new FleetDriverError({ message: `this machine cannot commit for ${canvasName} now`, cause: status.role, retryable: true }));
        }
        // One batch in flight: the next is judged only on committed state, or two edits at one base could both pass.
        if (status.lastIndex > status.commit) {
          return Effect.fail(new FleetDriverError({
            message: `a batch for ${canvasName} is appended and not yet committed`,
            cause: { lastIndex: status.lastIndex, commit: status.commit },
            retryable: true,
          }));
        }
        const captured: Array<RecordRulingInput> = [];
        const elsewhere = new Set<string>();
        const capture = (input: RecordRulingInput) => {
          if (input.canvasName === canvasName) captured.push(input);
          else elsewhere.add(input.canvasName);
        };
        let proposed = false;
        return Effect.gen(function* () {
          const appended = yield* durably(
            Effect.gen(function* () {
              // Judge against committed state and the batch's own earlier commands, then roll the judgment back.
              const value = yield* sql.withTransaction(
                Effect.flatMap(
                  batch.pipe(Effect.provideService(RulingCapture, capture), Effect.provideService(Judging, canvasName)),
                  (judged) =>
                    Effect.gen(function* () {
                      // The rows the savepoint holds, read before it rolls back, say which rulings stand: one a
                      // ruler recorded and then undid in a transaction of its own was captured, and must not be logged.
                      const standing: Array<RecordRulingInput> = [];
                      for (const input of captured) {
                        const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM resource_rulings
                          WHERE canvas_name = ${input.canvasName} AND writer = ${input.writer} AND op_id = ${input.command.opId}`;
                        if (row!.n > 0) standing.push(input);
                      }
                      captured.splice(0, captured.length, ...standing);
                      return yield* Effect.fail(new Judged(judged));
                    }),
                ),
              ).pipe(Effect.catchIf((error): error is Judged<A> => error instanceof Judged, (judged) => Effect.succeed(judged.value)));
              // Its rows rolled back with the savepoint and no entry carries them: answering would claim a write that never lands.
              if (elsewhere.size > 0) {
                return yield* Effect.fail(new FleetDriverError({
                  message: `a batch for ${canvasName} ruled on ${[...elsewhere].join(", ")}, which this authority does not rule`,
                  cause: [...elsewhere],
                }));
              }
              const ruledAt = Date.now();
              const entries: Array<Entry> = [];
              for (const input of captured) {
                const entry = yield* Effect.try({
                  try: () => node.propose(encodeLogData({ kind: "ruling", ruling: loggedRuling(input, ruledAt) })),
                  catch: (cause) => refusal(cause),
                });
                // From the first entry on, the core holds what the disk does not yet.
                proposed = true;
                entries.push(entry);
              }
              const ready = node.ready();
              yield* unrevoked(ready);
              // Appended in the judgment's own transaction: this machine's acknowledgement.
              yield* writeReady(ready);
              return { value, entries, ready };
            }),
          );
          // Applied, and only now answered.
          yield* applyCommitted(appended.ready);
          return { value: appended.value, entries: appended.entries, messages: appended.ready.messages };
        }).pipe(
          Effect.mapError((cause) => (proposed ? breaks(cause) : (cause as E | FleetDriverError))),
          Effect.catchDefect((defect) => Effect.fail(proposed ? breaks(defect) : failed(`the batch for ${canvasName} could not be judged`)(defect))),
        ) as Effect.Effect<Judgment<A>, E | FleetDriverError, R>;
      }));

    const guarded = <A>(run: () => A) =>
      Effect.suspend(() => (broken !== undefined ? Effect.fail(broken) : Effect.try({ try: run, catch: refusal })));

    /** Mutate the core, then drain it, holding the canvas throughout. */
    const held = <A>(mutate: () => A) => exclusive(Effect.flatMap(guarded(mutate), (result) => Effect.as(drain, result)));
    const drained = <A>(mutate: () => A) => exclusive(Effect.flatMap(guarded(mutate), () => drain));

    // A lone authority needs no one's vote: settle its election now, so it takes proposals when opened.
    const lone = () => {
      const members = node.status().members;
      return members.sole === self || (members.old === undefined && members.list.length === 1 && members.list[0] === self);
    };
    for (let at = 0; lone() && node.status().role !== "leader" && at <= electionTicks * 2; at++) node.tick();
    yield* drain;

    return {
      status: () => node.status(),
      judge,
      propose: (data) => held(() => node.propose(encodeLogData(data))),
      tick: () => drained(() => node.tick()),
      step: (message) => drained(() => node.step(message)),
      alone: () => drained(() => node.alone()),
    } satisfies CanvasAuthority;
  });
