import { Context, Effect, Layer, Schema } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import {
  StateEngine,
  type StateReader,
} from "../state/service";
import {
  ensureHostRegistryState,
  upsertHostState,
} from "../hosts/registry";
import { BoxMachine, type BoxMachine as BoxMachineType } from "./domain";
import {
  admitOwnedBox,
  inspectOwnedBox,
  type OwnedBox,
  type OwnedBoxRecord,
} from "./ownership";

export const boxHostId = (boxId: string): string =>
  `box-${boxId.slice(3)}`;

export const BoxResource = Schema.Struct({
  machine: BoxMachine,
  hostId: Schema.optionalKey(Schema.String),
  enrolledAt: Schema.String,
  sshPreparedAt: Schema.optionalKey(Schema.String),
  sshVerifiedAt: Schema.optionalKey(Schema.String),
});
export type BoxResource = typeof BoxResource.Type;

type BoxResourceRow = {
  readonly box_id: string;
  readonly host_id: string | null;
  readonly name: string;
  readonly machine_ip: string | null;
  readonly machine_state: string;
  readonly provider_created_at: string | null;
  readonly provider_updated_at: string | null;
  readonly ssh_prepared_at: string | null;
  readonly ssh_verified_at: string | null;
  readonly enrolled_at: string;
};

export class BoxOwnershipNotFoundError extends Schema.TaggedErrorClass<BoxOwnershipNotFoundError>()(
  "BoxOwnershipNotFoundError",
  {
    boxId: Schema.String,
    detail: Schema.String,
  },
) {}

export class BoxOwnershipPersistenceError extends Schema.TaggedErrorClass<BoxOwnershipPersistenceError>()(
  "BoxOwnershipPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type BoxOwnershipError =
  | BoxOwnershipNotFoundError
  | BoxOwnershipPersistenceError;

const rowToResource = (row: BoxResourceRow): BoxResource =>
  Schema.decodeUnknownSync(BoxResource)({
    machine: {
      id: row.box_id,
      name: row.name,
      ip: row.machine_ip,
      state: row.machine_state,
      createdAt: row.provider_created_at,
      updatedAt: row.provider_updated_at,
    },
    ...(row.host_id === null ? {} : { hostId: row.host_id }),
    enrolledAt: row.enrolled_at,
    ...(row.ssh_prepared_at === null
      ? {}
      : { sshPreparedAt: row.ssh_prepared_at }),
    ...(row.ssh_verified_at === null
      ? {}
      : { sshVerifiedAt: row.ssh_verified_at }),
  });

const selectByBoxId = (
  reader: StateReader,
  boxId: string,
): BoxResourceRow | undefined =>
  reader.get<BoxResourceRow>(
    `SELECT
       box_id,
       host_id,
       name,
       machine_ip,
       machine_state,
       provider_created_at,
       provider_updated_at,
       ssh_prepared_at,
       ssh_verified_at,
       enrolled_at
     FROM box_resources
     WHERE box_id = ?`,
    [boxId],
  );

const toPersistenceError = (
  operation: string,
  cause: unknown,
): BoxOwnershipPersistenceError =>
  BoxOwnershipPersistenceError.make({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const hostForMachine = (
  machine: BoxMachineType,
  identityFile: string,
): RemoteHost => {
  if (machine.ip === null || machine.ip.trim() === "") {
    throw new Error(`Box ${machine.id} did not provide an SSH address`);
  }
  return {
    id: boxHostId(machine.id),
    label: machine.name.trim() || `Box ${machine.id.slice(3)}`,
    kind: "remote",
    sshEndpoint: `user@${machine.ip}`,
    sshIdentityFile: identityFile,
    sshHostKeyPolicy: "accept-new",
    capabilities: ["terminal", "browser", "hermes"],
    appearance: { glyph: "compute-tower" },
  };
};

const isSshUsableState = (state: string): boolean =>
  state === "ready" || state === "idle" || state === "running";

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/box/BoxOwnershipRepository` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class BoxOwnershipRepository extends Context.Service<BoxOwnershipRepository, BoxOwnershipRepository>()("@vellum/box/BoxOwnershipRepository") {}`
 * - Layer today: BoxOwnershipRepositoryLive — V4 rename candidate BoxOwnershipRepository.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class BoxOwnershipRepository extends Context.Service<BoxOwnershipRepository,
  {
    readonly enrollCreated: (
      machine: BoxMachineType,
    ) => Effect.Effect<OwnedBox, BoxOwnershipPersistenceError>;
    readonly requireOwned: (
      boxId: string,
    ) => Effect.Effect<OwnedBox, BoxOwnershipError>;
    /**
     * Resolve only the deterministic host identity of a resource already
     * present in Vellum Command ownership state. Account inventory is never queried.
     */
    readonly findOwnedByHostId: (
      hostId: string,
    ) => Effect.Effect<OwnedBox | undefined, BoxOwnershipPersistenceError>;
    readonly list: Effect.Effect<
      ReadonlyArray<BoxResource>,
      BoxOwnershipPersistenceError
    >;
    readonly updateMachine: (
      box: OwnedBox,
      machine: BoxMachineType,
    ) => Effect.Effect<OwnedBox, BoxOwnershipPersistenceError>;
    readonly markSshPrepared: (
      box: OwnedBox,
    ) => Effect.Effect<OwnedBox, BoxOwnershipPersistenceError>;
    readonly enrollVerifiedHost: (
      box: OwnedBox,
      identityFile: string,
    ) => Effect.Effect<OwnedBox, BoxOwnershipPersistenceError>;
    /**
     * Drop local ownership + fleet host placement. Does not stop or destroy
     * the provider Box — only detaches it from Vellum Command.
     */
    readonly detach: (
      box: OwnedBox,
    ) => Effect.Effect<void, BoxOwnershipPersistenceError>;
  }>()("@vellum/box/BoxOwnershipRepository") {}

export const BoxOwnershipRepositoryLive = Layer.effect(
  BoxOwnershipRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const enrollCreated = Effect.fn("BoxOwnershipRepository.enrollCreated")(
      function* (machine: BoxMachineType) {
        const enrolledAt = new Date().toISOString();
        const record = yield* state
          .transaction("box.ownership.enroll", (writer) => {
            ensureHostRegistryState(writer, enrolledAt);
            const existing = selectByBoxId(writer, machine.id);
            if (existing !== undefined) return rowToResource(existing);
            writer.run(
              `INSERT INTO box_resources(
                 box_id,
                 host_id,
                 name,
                 machine_ip,
                 machine_state,
                 provider_created_at,
                 provider_updated_at,
                 ssh_prepared_at,
                 ssh_verified_at,
                 enrolled_at
               ) VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
              [
                machine.id,
                machine.name,
                machine.ip,
                machine.state,
                machine.createdAt,
                machine.updatedAt,
                enrolledAt,
              ],
            );
            return {
              machine,
              enrolledAt,
            } satisfies BoxResource;
          })
          .pipe(
            Effect.mapError((error) =>
              toPersistenceError("enroll-created", error),
            ),
          );
        return admitOwnedBox(record satisfies OwnedBoxRecord);
      },
    );

    const requireOwned = Effect.fn("BoxOwnershipRepository.requireOwned")(
      function* (boxId: string) {
        const record = yield* state
          .read("box.ownership.require", (reader) => {
            const row = selectByBoxId(reader, boxId);
            return row === undefined ? undefined : rowToResource(row);
          })
          .pipe(
            Effect.mapError((error) =>
              toPersistenceError("require-owned", error),
            ),
          );
        if (record === undefined) {
          return yield* BoxOwnershipNotFoundError.make({
            boxId,
            detail:
              `Box ${JSON.stringify(boxId)} is not recorded as Vellum Command-created; lifecycle access refused`,
          });
        }
        return admitOwnedBox(record satisfies OwnedBoxRecord);
      },
    );

    const findOwnedByHostId = Effect.fn(
      "BoxOwnershipRepository.findOwnedByHostId",
    )(function* (hostId: string) {
      const record = yield* state
        .read("box.ownership.find-by-host", (reader) => {
          const row = reader.get<BoxResourceRow>(
            `SELECT
               box_id,
               host_id,
               name,
               machine_ip,
               machine_state,
               provider_created_at,
               provider_updated_at,
               ssh_prepared_at,
               ssh_verified_at,
               enrolled_at
             FROM box_resources
             WHERE ('box-' || substr(box_id, 4)) = ?`,
            [hostId],
          );
          return row === undefined ? undefined : rowToResource(row);
        })
        .pipe(
          Effect.mapError((error) =>
            toPersistenceError("find-owned-by-host", error),
          ),
        );
      return record === undefined
        ? undefined
        : admitOwnedBox(record satisfies OwnedBoxRecord);
    });

    const list = state
      .read("box.ownership.list", (reader) =>
        reader
          .all<BoxResourceRow>(
            `SELECT
               box_id,
               host_id,
               name,
               machine_ip,
               machine_state,
               provider_created_at,
               provider_updated_at,
               ssh_prepared_at,
               ssh_verified_at,
               enrolled_at
             FROM box_resources
             ORDER BY enrolled_at, box_id`,
          )
          .map(rowToResource),
      )
      .pipe(
        Effect.mapError((error) => toPersistenceError("list", error)),
      );

    const updateMachine = Effect.fn("BoxOwnershipRepository.updateMachine")(
      function* (box: OwnedBox, machine: BoxMachineType) {
        const current = inspectOwnedBox(box);
        if (current.machine.id !== machine.id) {
          return yield* BoxOwnershipPersistenceError.make({
            operation: "update-machine",
            detail: "Box command receipt did not match the admitted resource",
            cause: new Error("Box ownership identity mismatch"),
          });
        }
        const record = yield* state
          .transaction("box.ownership.update-machine", (writer) => {
            const row = selectByBoxId(writer, machine.id);
            if (row === undefined) {
              throw new Error("Box ownership disappeared during update");
            }
            // IP churn is normal on stop/resume. Keep the fleet host row and
            // rewrite its OpenSSH endpoint in place — never drop placement.
            const ipChanged =
              row.machine_ip !== machine.ip &&
              machine.ip !== null &&
              machine.ip.trim() !== "";
            // Re-verify only when the route identity changed; stopped state
            // keeps the last endpoint so the host stays visible as unreachable.
            writer.run(
              `UPDATE box_resources
               SET name = ?,
                   machine_ip = ?,
                   machine_state = ?,
                   provider_updated_at = ?,
                   ssh_prepared_at =
                     CASE WHEN ? THEN NULL ELSE ssh_prepared_at END,
                   ssh_verified_at =
                     CASE WHEN ? THEN NULL ELSE ssh_verified_at END
               WHERE box_id = ?`,
              [
                machine.name,
                machine.ip,
                machine.state,
                machine.updatedAt,
                ipChanged ? 1 : 0,
                ipChanged ? 1 : 0,
                machine.id,
              ],
            );
            if (ipChanged && row.host_id !== null) {
              const label = machine.name.trim() || row.name;
              writer.run(
                `UPDATE host_registry
                 SET ssh_endpoint = ?,
                     label = ?
                 WHERE id = ?`,
                [`user@${machine.ip}`, label, row.host_id],
              );
            }
            const updated = selectByBoxId(writer, machine.id);
            if (updated === undefined) {
              throw new Error("Box ownership disappeared after update");
            }
            return rowToResource(updated);
          })
          .pipe(
            Effect.mapError((error) =>
              toPersistenceError("update-machine", error),
            ),
          );
        return admitOwnedBox(record satisfies OwnedBoxRecord);
      },
    );

    const markSshPrepared = Effect.fn(
      "BoxOwnershipRepository.markSshPrepared",
    )(function* (box: OwnedBox) {
      const current = inspectOwnedBox(box);
      const preparedAt = new Date().toISOString();
      const record = yield* state
        .transaction("box.ownership.mark-ssh-prepared", (writer) => {
          const row = selectByBoxId(writer, current.machine.id);
          if (row === undefined) {
            throw new Error("Box ownership disappeared before SSH preparation");
          }
          writer.run(
            `UPDATE box_resources
             SET ssh_prepared_at = ?,
                 ssh_verified_at = NULL
             WHERE box_id = ?`,
            [preparedAt, current.machine.id],
          );
          const updated = selectByBoxId(writer, current.machine.id);
          if (updated === undefined) {
            throw new Error("Box ownership disappeared after SSH preparation");
          }
          return rowToResource(updated);
        })
        .pipe(
          Effect.mapError((error) =>
            toPersistenceError("mark-ssh-prepared", error),
          ),
        );
      return admitOwnedBox(record satisfies OwnedBoxRecord);
    });

    const enrollVerifiedHost = Effect.fn(
      "BoxOwnershipRepository.enrollVerifiedHost",
    )(function* (box: OwnedBox, identityFile: string) {
      const current = inspectOwnedBox(box);
      if (
        !isSshUsableState(current.machine.state) ||
        current.machine.ip === null
      ) {
        return yield* BoxOwnershipPersistenceError.make({
          operation: "enroll-verified-host",
          detail: "Box is not ready for an OpenSSH route",
          cause: new Error("provider machine is not SSH-usable"),
        });
      }
      const host = hostForMachine(current.machine, identityFile);
      const verifiedAt = new Date().toISOString();
      const record = yield* state
        .transaction("box.ownership.enroll-verified-host", (writer) => {
          const row = selectByBoxId(writer, current.machine.id);
          if (row === undefined) {
            throw new Error("Box ownership disappeared before host enrollment");
          }
          if (row.machine_ip !== current.machine.ip) {
            throw new Error("Box route changed during OpenSSH verification");
          }
          ensureHostRegistryState(writer, verifiedAt);
          upsertHostState(writer, host);
          writer.run(
            `UPDATE box_resources
             SET host_id = ?,
                 ssh_verified_at = ?
             WHERE box_id = ?`,
            [host.id, verifiedAt, current.machine.id],
          );
          const updated = selectByBoxId(writer, current.machine.id);
          if (updated === undefined) {
            throw new Error("Box ownership disappeared after host enrollment");
          }
          return rowToResource(updated);
        })
        .pipe(
          Effect.mapError((error) =>
            toPersistenceError("enroll-verified-host", error),
          ),
        );
      return admitOwnedBox(record satisfies OwnedBoxRecord);
    });

    const detach = Effect.fn("BoxOwnershipRepository.detach")(function* (
      box: OwnedBox,
    ) {
      const current = inspectOwnedBox(box);
      yield* state
        .transaction("box.ownership.detach", (writer) => {
          const row = selectByBoxId(writer, current.machine.id);
          if (row === undefined) {
            throw new Error("Box ownership disappeared before detach");
          }
          // box_resources.host_id → host_registry ON DELETE RESTRICT
          if (row.host_id !== null) {
            writer.run(
              `UPDATE box_resources
               SET host_id = NULL,
                   ssh_prepared_at = NULL,
                   ssh_verified_at = NULL
               WHERE box_id = ?`,
              [current.machine.id],
            );
            writer.run("DELETE FROM host_registry WHERE id = ?", [
              row.host_id,
            ]);
          }
          writer.run("DELETE FROM box_resources WHERE box_id = ?", [
            current.machine.id,
          ]);
        })
        .pipe(
          Effect.mapError((error) => toPersistenceError("detach", error)),
        );
    });

    return BoxOwnershipRepository.of({
      enrollCreated,
      requireOwned,
      findOwnedByHostId,
      list,
      updateMachine,
      markSshPrepared,
      enrollVerifiedHost,
      detach,
    });
  }),
);
