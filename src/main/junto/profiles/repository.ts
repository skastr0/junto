import { Cause, Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { ulid } from "ulid";
import {
  PROFILES_MAX,
  PROFILE_NAME_MAX,
  decodeProfileBody,
  type AgentProfile,
  type ProfileSaveInput,
} from "@shared/agent-profiles";
import { StateTransactionOperation } from "../state/service";

export class ProfilePersistenceError extends Schema.TaggedError<ProfilePersistenceError>()(
  "ProfilePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** The operator's input cannot be saved: bad body, taken name, or no such profile. */
export class ProfileRefused extends Schema.TaggedError<ProfileRefused>()("ProfileRefused", {
  message: Schema.String,
}) {}

export type ProfileRepositoryError = ProfilePersistenceError | ProfileRefused;

/** Durable agent profiles (`agent_profiles`). */
export class ProfileRepository extends Context.Service<ProfileRepository,
  {
    /** Every readable profile, by name. A row whose body no longer decodes is skipped. */
    readonly list: () => Effect.Effect<ReadonlyArray<AgentProfile>, ProfileRepositoryError>;
    /** Create (no id) or replace one profile's configuration. */
    readonly save: (input: ProfileSaveInput) => Effect.Effect<AgentProfile, ProfileRepositoryError>;
    readonly rename: (profileId: string, name: string) => Effect.Effect<AgentProfile, ProfileRepositoryError>;
    readonly remove: (profileId: string) => Effect.Effect<string, ProfileRepositoryError>;
  }>()("@junto/ProfileRepository") {}

const ProfileRow = Schema.Struct({
  profile_id: Schema.String,
  name: Schema.String,
  body_json: Schema.String,
  created_at: Schema.Number,
  updated_at: Schema.Number,
});

const COLUMNS = "profile_id, name, body_json, created_at, updated_at";

/** Decode-admits-history: a body a later build cannot read is skipped, not fatal. */
const fromRow = (row: typeof ProfileRow.Type): AgentProfile | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(row.body_json);
  } catch {
    return undefined;
  }
  // The name column is the profile's name; the body's copy follows a rename.
  const body = decodeProfileBody({ ...(raw as object), name: row.name });
  if (body === null) return undefined;
  return {
    ...body,
    profileId: row.profile_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
};

const refuse = (message: string) => ProfileRefused.make({ message });

const cleanBody = Effect.fn("agent-profiles.clean-body")(function* (body: unknown) {
  const decoded = decodeProfileBody(body);
  if (decoded === null) return yield* refuse(`a profile needs a name of 1 to ${PROFILE_NAME_MAX} characters and a harness`);
  return decoded;
});

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError | ProfileRefused) =>
  error instanceof ProfileRefused
    ? error
    : ProfilePersistenceError.make({ operation, message: error.message, cause: error });

export const ProfileRepositoryLive: Layer.Layer<ProfileRepository, never, SqlClient.SqlClient> = Layer.effect(
  ProfileRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Union([Schema.Number, Schema.BigInt]) }));
    const oneRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ProfileRow,
      execute: (profileId) => sql.unsafe(`SELECT ${COLUMNS} FROM agent_profiles WHERE profile_id = ?`, [profileId]),
    });
    const readOne = Effect.fn("agent-profiles.read-one")(function* (profileId: string) {
      const row = yield* oneRow(profileId);
      return row._tag === "None" ? undefined : fromRow(row.value);
    });
    const allRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ProfileRow,
      execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM agent_profiles ORDER BY name COLLATE NOCASE, profile_id`),
    });
    const nameTaken = SqlSchema.findOneOption({
      Request: Schema.Tuple([Schema.String, Schema.String]),
      Result: Schema.Struct({ profile_id: Schema.String }),
      execute: ([name, exceptId]) => sql`
        SELECT profile_id FROM agent_profiles WHERE name = ${name} COLLATE NOCASE AND profile_id <> ${exceptId}
      `,
    });
    const count = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ n: Schema.Number }),
      execute: () => sql`SELECT count(*) AS n FROM agent_profiles`,
    });

    const list = Effect.fn("agent-profiles.list")(function* () {
      return (yield* allRows(undefined)).flatMap((row) => {
        const profile = fromRow(row);
        return profile ? [profile] : [];
      });
    }, Effect.mapError(persistence("list")));

    const save = Effect.fn("agent-profiles.save")(function* (input: ProfileSaveInput) {
      const body = yield* cleanBody(input.body);
      const profileId = input.profileId ?? `profile-${ulid()}`;
      if ((yield* nameTaken([body.name, profileId]))._tag === "Some") return yield* refuse(`a profile named ${body.name} already exists`);
      const bodyJson = JSON.stringify(body);
      const now = Date.now();
      if (input.profileId === undefined) {
        if ((yield* count(undefined)).n >= PROFILES_MAX) return yield* refuse(`at most ${PROFILES_MAX} profiles`);
        yield* sql.unsafe(`INSERT INTO agent_profiles(${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
          [profileId, body.name, bodyJson, now, now]);
      } else {
        const changed = yield* sql`
          UPDATE agent_profiles SET name = ${body.name}, body_json = ${bodyJson}, updated_at = max(created_at, ${now})
          WHERE profile_id = ${profileId}
        `.raw.pipe(Effect.flatMap(changes));
        if (Number(changed.changes) === 0) return yield* refuse("that profile no longer exists");
      }
      return (yield* readOne(profileId))!;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-profiles.save"),
    Effect.mapError(persistence("save")));

    const rename = Effect.fn("agent-profiles.rename")(function* (profileId: string, rawName: string) {
      const current = yield* readOne(profileId);
      if (!current) return yield* refuse("that profile no longer exists");
      const body = yield* cleanBody({ ...current, name: rawName });
      if ((yield* nameTaken([body.name, profileId]))._tag === "Some") return yield* refuse(`a profile named ${body.name} already exists`);
      yield* sql`
        UPDATE agent_profiles SET name = ${body.name}, body_json = ${JSON.stringify(body)}, updated_at = max(created_at, ${Date.now()})
        WHERE profile_id = ${profileId}
      `;
      const profile = yield* readOne(profileId);
      if (!profile) return yield* refuse("that profile can no longer be read");
      return profile;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-profiles.rename"),
    Effect.mapError(persistence("rename")));

    const remove = Effect.fn("agent-profiles.remove")(function* (profileId: string) {
      const changed = yield* sql`DELETE FROM agent_profiles WHERE profile_id = ${profileId}`.raw.pipe(Effect.flatMap(changes));
      if (Number(changed.changes) === 0) return yield* refuse("that profile no longer exists");
      return profileId;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "agent-profiles.remove"),
    Effect.mapError(persistence("remove")));

    return ProfileRepository.of({ list, save, rename, remove });
  }),
);
