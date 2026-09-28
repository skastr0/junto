import { Cause, Context, Effect, Layer, Result, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { ulid } from "ulid";
import {
  SQUADS_MAX,
  decodeSquadBody,
  decodeSquadName,
  type Squad,
  type SquadSaveInput,
} from "@shared/squads";
import { StateTransactionOperation } from "../state/service";

export class SquadPersistenceError extends Schema.TaggedError<SquadPersistenceError>()(
  "SquadPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** The operator's input cannot be saved: bad name, bad template, taken name, or no such squad. */
export class SquadRefused extends Schema.TaggedError<SquadRefused>()("SquadRefused", {
  message: Schema.String,
}) {}

export type SquadRepositoryError = SquadPersistenceError | SquadRefused;

/** Durable squads (`squads`): the operator's reusable seat templates. */
export class SquadRepository extends Context.Service<SquadRepository,
  {
    /** Every readable squad, by name. A row whose body no longer decodes is skipped. */
    readonly list: () => Effect.Effect<ReadonlyArray<Squad>, SquadRepositoryError>;
    /** Create a squad. A taken name is refused; nothing is ever replaced. */
    readonly save: (input: SquadSaveInput) => Effect.Effect<Squad, SquadRepositoryError>;
    readonly rename: (squadId: string, name: string) => Effect.Effect<Squad, SquadRepositoryError>;
    readonly remove: (squadId: string) => Effect.Effect<string, SquadRepositoryError>;
  }>()("@junto/SquadRepository") {}

const SquadRow = Schema.Struct({
  squad_id: Schema.String,
  name: Schema.String,
  body_json: Schema.String,
  created_at: Schema.Number,
  updated_at: Schema.Number,
});

const COLUMNS = "squad_id, name, body_json, created_at, updated_at";

/** Decode-admits-history: a body a later build cannot read is skipped, not fatal. */
const fromRow = (row: typeof SquadRow.Type): Squad | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(row.body_json);
  } catch {
    return undefined;
  }
  const body = decodeSquadBody(raw);
  if (Result.isFailure(body)) return undefined;
  return {
    ...body.success,
    squadId: row.squad_id,
    name: row.name,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
};

const refuse = (message: string) => SquadRefused.make({ message });

const cleanName = Effect.fn("squads.clean-name")(function* (name: unknown) {
  const decoded = decodeSquadName(name);
  if (Result.isFailure(decoded)) return yield* refuse("a squad needs a name of 1 to 60 characters");
  return decoded.success.trim();
});

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError | SquadRefused) =>
  error instanceof SquadRefused
    ? error
    : SquadPersistenceError.make({ operation, message: error.message, cause: error });

export const SquadRepositoryLive: Layer.Layer<SquadRepository, never, SqlClient.SqlClient> = Layer.effect(
  SquadRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Union([Schema.Number, Schema.BigInt]) }));
    const oneRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SquadRow,
      execute: (squadId) => sql.unsafe(`SELECT ${COLUMNS} FROM squads WHERE squad_id = ?`, [squadId]),
    });
    const readOne = Effect.fn("squads.read-one")(function* (squadId: string) {
      const row = yield* oneRow(squadId);
      return row._tag === "None" ? undefined : fromRow(row.value);
    });
    const allRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SquadRow,
      execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM squads ORDER BY name COLLATE NOCASE, squad_id`),
    });
    const nameTaken = SqlSchema.findOneOption({
      Request: Schema.Tuple([Schema.String, Schema.String]),
      Result: Schema.Struct({ squad_id: Schema.String }),
      execute: ([name, exceptId]) => sql`
        SELECT squad_id FROM squads WHERE name = ${name} COLLATE NOCASE AND squad_id <> ${exceptId}
      `,
    });
    const count = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ n: Schema.Number }),
      execute: () => sql`SELECT count(*) AS n FROM squads`,
    });

    const list = Effect.fn("squads.list")(function* () {
      return (yield* allRows(undefined)).flatMap((row) => {
        const squad = fromRow(row);
        return squad ? [squad] : [];
      });
    }, Effect.mapError(persistence("list")));

    const save = Effect.fn("squads.save")(function* (input: SquadSaveInput) {
      const name = yield* cleanName(input.name);
      const body = decodeSquadBody(input.body);
      if (Result.isFailure(body)) return yield* refuse("the squad template is not valid");
      const squadId = `squad-${ulid()}`;
      if ((yield* nameTaken([name, ""]))._tag === "Some") return yield* refuse(`a squad named ${name} already exists`);
      if ((yield* count(undefined)).n >= SQUADS_MAX) return yield* refuse(`at most ${SQUADS_MAX} squads`);
      const now = Date.now();
      yield* sql.unsafe(`INSERT INTO squads(${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
        [squadId, name, JSON.stringify(body.success), now, now]);
      return (yield* readOne(squadId))!;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "squads.save"),
    Effect.mapError(persistence("save")));

    const rename = Effect.fn("squads.rename")(function* (squadId: string, rawName: string) {
      const name = yield* cleanName(rawName);
      if ((yield* nameTaken([name, squadId]))._tag === "Some") return yield* refuse(`a squad named ${name} already exists`);
      const changed = yield* sql`
        UPDATE squads SET name = ${name}, updated_at = max(created_at, ${Date.now()}) WHERE squad_id = ${squadId}
      `.raw.pipe(Effect.flatMap(changes));
      if (Number(changed.changes) === 0) return yield* refuse("that squad no longer exists");
      const squad = yield* readOne(squadId);
      if (!squad) return yield* refuse("that squad can no longer be read");
      return squad;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "squads.rename"),
    Effect.mapError(persistence("rename")));

    const remove = Effect.fn("squads.remove")(function* (squadId: string) {
      const changed = yield* sql`DELETE FROM squads WHERE squad_id = ${squadId}`.raw.pipe(Effect.flatMap(changes));
      if (Number(changed.changes) === 0) return yield* refuse("that squad no longer exists");
      return squadId;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "squads.remove"),
    Effect.mapError(persistence("remove")));

    return SquadRepository.of({ list, save, rename, remove });
  }),
);
