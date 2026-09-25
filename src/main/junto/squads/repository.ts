import { Context, Effect, Layer, Result, Schema } from "effect";
import { ulid } from "ulid";
import {
  SQUADS_MAX,
  decodeSquadBody,
  decodeSquadName,
  type Squad,
  type SquadSaveInput,
} from "@shared/squads";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
} from "../state/service";

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
    /** Create (no id) or replace one squad's name and template. */
    readonly save: (input: SquadSaveInput) => Effect.Effect<Squad, SquadRepositoryError>;
    readonly rename: (squadId: string, name: string) => Effect.Effect<Squad, SquadRepositoryError>;
    readonly remove: (squadId: string) => Effect.Effect<string, SquadRepositoryError>;
  }>()("@junto/SquadRepository") {}

type SquadRow = StateRow & {
  readonly squad_id: string;
  readonly name: string;
  readonly body_json: string;
  readonly created_at: number;
  readonly updated_at: number;
};

const COLUMNS = "squad_id, name, body_json, created_at, updated_at";

/** Decode-admits-history: a body a later build cannot read is skipped, not fatal. */
const fromRow = (row: SquadRow): Squad | undefined => {
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

const readOne = (reader: StateReader, squadId: string): Squad | undefined => {
  const row = reader.get<SquadRow>(`SELECT ${COLUMNS} FROM squads WHERE squad_id = ?`, [squadId]);
  return row === undefined ? undefined : fromRow(row);
};

const refuse = (message: string) => SquadRefused.make({ message });

const cleanName = (name: unknown): string => {
  const decoded = decodeSquadName(name);
  if (Result.isFailure(decoded)) throw refuse("a squad needs a name of 1 to 60 characters");
  return decoded.success.trim();
};

const nameTaken = (reader: StateReader, name: string, exceptId?: string): boolean =>
  reader.get<StateRow & { readonly squad_id: string }>(
    "SELECT squad_id FROM squads WHERE name = ? COLLATE NOCASE AND squad_id <> ?",
    [name, exceptId ?? ""],
  ) !== undefined;

const persistence = (operation: string) => (error: StateEngineError) =>
  error.cause instanceof SquadRefused
    ? error.cause
    : SquadPersistenceError.make({ operation, message: error.message, cause: error });

export const SquadRepositoryLive: Layer.Layer<SquadRepository, never, StateEngine> = Layer.effect(
  SquadRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const list = () =>
      state
        .read("squads.list", (reader) =>
          reader
            .all<SquadRow>(`SELECT ${COLUMNS} FROM squads ORDER BY name COLLATE NOCASE, squad_id`)
            .flatMap((row) => {
              const squad = fromRow(row);
              return squad ? [squad] : [];
            }),
        )
        .pipe(Effect.mapError(persistence("list")));

    const save = (input: SquadSaveInput) =>
      state
        .transaction("squads.save", (writer) => {
          const name = cleanName(input.name);
          const body = decodeSquadBody(input.body);
          if (Result.isFailure(body)) throw refuse("the squad template is not valid");
          const bodyJson = JSON.stringify(body.success);
          const squadId = input.squadId ?? `squad-${ulid()}`;
          if (nameTaken(writer, name, squadId)) throw refuse(`a squad named ${name} already exists`);
          const now = Date.now();
          if (input.squadId === undefined) {
            const count = writer.get<StateRow & { readonly n: number }>("SELECT count(*) AS n FROM squads");
            if (Number(count?.n ?? 0) >= SQUADS_MAX) throw refuse(`at most ${SQUADS_MAX} squads`);
            writer.run(
              `INSERT INTO squads(${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
              [squadId, name, bodyJson, now, now],
            );
          } else {
            const changed = writer.run(
              "UPDATE squads SET name = ?, body_json = ?, updated_at = max(created_at, ?) WHERE squad_id = ?",
              [name, bodyJson, now, squadId],
            );
            if (Number(changed.changes) === 0) throw refuse("that squad no longer exists");
          }
          return readOne(writer, squadId)!;
        })
        .pipe(Effect.mapError(persistence("save")));

    const rename = (squadId: string, rawName: string) =>
      state
        .transaction("squads.rename", (writer) => {
          const name = cleanName(rawName);
          if (nameTaken(writer, name, squadId)) throw refuse(`a squad named ${name} already exists`);
          const changed = writer.run(
            "UPDATE squads SET name = ?, updated_at = max(created_at, ?) WHERE squad_id = ?",
            [name, Date.now(), squadId],
          );
          if (Number(changed.changes) === 0) throw refuse("that squad no longer exists");
          const squad = readOne(writer, squadId);
          if (!squad) throw refuse("that squad can no longer be read");
          return squad;
        })
        .pipe(Effect.mapError(persistence("rename")));

    const remove = (squadId: string) =>
      state
        .transaction("squads.remove", (writer) => {
          const changed = writer.run("DELETE FROM squads WHERE squad_id = ?", [squadId]);
          if (Number(changed.changes) === 0) throw refuse("that squad no longer exists");
          return squadId;
        })
        .pipe(Effect.mapError(persistence("remove")));

    return SquadRepository.of({ list, save, rename, remove });
  }),
);
