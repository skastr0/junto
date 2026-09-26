import { Context, Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";
import {
  PROFILES_MAX,
  PROFILE_NAME_MAX,
  decodeProfileBody,
  type AgentProfile,
  type AgentProfileBody,
  type ProfileSaveInput,
} from "@shared/agent-profiles";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
} from "../state/service";

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

type ProfileRow = StateRow & {
  readonly profile_id: string;
  readonly name: string;
  readonly body_json: string;
  readonly created_at: number;
  readonly updated_at: number;
};

const COLUMNS = "profile_id, name, body_json, created_at, updated_at";

/** Decode-admits-history: a body a later build cannot read is skipped, not fatal. */
const fromRow = (row: ProfileRow): AgentProfile | undefined => {
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

const readOne = (reader: StateReader, profileId: string): AgentProfile | undefined => {
  const row = reader.get<ProfileRow>(`SELECT ${COLUMNS} FROM agent_profiles WHERE profile_id = ?`, [profileId]);
  return row === undefined ? undefined : fromRow(row);
};

const refuse = (message: string) => ProfileRefused.make({ message });

const cleanBody = (body: unknown): AgentProfileBody => {
  const decoded = decodeProfileBody(body);
  if (decoded === null) throw refuse(`a profile needs a name of 1 to ${PROFILE_NAME_MAX} characters and a harness`);
  return decoded;
};

const nameTaken = (reader: StateReader, name: string, exceptId?: string): boolean =>
  reader.get<StateRow & { readonly profile_id: string }>(
    "SELECT profile_id FROM agent_profiles WHERE name = ? COLLATE NOCASE AND profile_id <> ?",
    [name, exceptId ?? ""],
  ) !== undefined;

const persistence = (operation: string) => (error: StateEngineError) =>
  error.cause instanceof ProfileRefused
    ? error.cause
    : ProfilePersistenceError.make({ operation, message: error.message, cause: error });

export const ProfileRepositoryLive: Layer.Layer<ProfileRepository, never, StateEngine> = Layer.effect(
  ProfileRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const list = () =>
      state
        .read("agent-profiles.list", (reader) =>
          reader
            .all<ProfileRow>(`SELECT ${COLUMNS} FROM agent_profiles ORDER BY name COLLATE NOCASE, profile_id`)
            .flatMap((row) => {
              const profile = fromRow(row);
              return profile ? [profile] : [];
            }),
        )
        .pipe(Effect.mapError(persistence("list")));

    const save = (input: ProfileSaveInput) =>
      state
        .transaction("agent-profiles.save", (writer) => {
          const body = cleanBody(input.body);
          const profileId = input.profileId ?? `profile-${ulid()}`;
          if (nameTaken(writer, body.name, profileId)) throw refuse(`a profile named ${body.name} already exists`);
          const bodyJson = JSON.stringify(body);
          const now = Date.now();
          if (input.profileId === undefined) {
            const count = writer.get<StateRow & { readonly n: number }>("SELECT count(*) AS n FROM agent_profiles");
            if (Number(count?.n ?? 0) >= PROFILES_MAX) throw refuse(`at most ${PROFILES_MAX} profiles`);
            writer.run(
              `INSERT INTO agent_profiles(${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
              [profileId, body.name, bodyJson, now, now],
            );
          } else {
            const changed = writer.run(
              "UPDATE agent_profiles SET name = ?, body_json = ?, updated_at = max(created_at, ?) WHERE profile_id = ?",
              [body.name, bodyJson, now, profileId],
            );
            if (Number(changed.changes) === 0) throw refuse("that profile no longer exists");
          }
          return readOne(writer, profileId)!;
        })
        .pipe(Effect.mapError(persistence("save")));

    const rename = (profileId: string, rawName: string) =>
      state
        .transaction("agent-profiles.rename", (writer) => {
          const current = readOne(writer, profileId);
          if (!current) throw refuse("that profile no longer exists");
          const body = cleanBody({ ...current, name: rawName });
          if (nameTaken(writer, body.name, profileId)) throw refuse(`a profile named ${body.name} already exists`);
          writer.run(
            "UPDATE agent_profiles SET name = ?, body_json = ?, updated_at = max(created_at, ?) WHERE profile_id = ?",
            [body.name, JSON.stringify(body), Date.now(), profileId],
          );
          const profile = readOne(writer, profileId);
          if (!profile) throw refuse("that profile can no longer be read");
          return profile;
        })
        .pipe(Effect.mapError(persistence("rename")));

    const remove = (profileId: string) =>
      state
        .transaction("agent-profiles.remove", (writer) => {
          const changed = writer.run("DELETE FROM agent_profiles WHERE profile_id = ?", [profileId]);
          if (Number(changed.changes) === 0) throw refuse("that profile no longer exists");
          return profileId;
        })
        .pipe(Effect.mapError(persistence("remove")));

    return ProfileRepository.of({ list, save, rename, remove });
  }),
);
