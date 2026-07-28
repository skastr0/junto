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

export const BoxResource = Schema.Struct({
  machine: BoxMachine,
  hostId: Schema.optionalWith(Schema.String, { exact: true }),
  enrolledAt: Schema.String,
  sshPreparedAt: Schema.optionalWith(Schema.String, { exact: true }),
  sshVerifiedAt: Schema.optionalWith(Schema.String, { exact: true }),
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

export class BoxOwnershipNotFoundError extends Schema.TaggedError<BoxOwnershipNotFoundError>()(
  "BoxOwnershipNotFoundError",
  {
    boxId: Schema.String,
    detail: Schema.String,
  },
) {}

export class BoxOwnershipPersistenceError extends Schema.TaggedError<BoxOwnershipPersistenceError>()(
  "BoxOwnershipPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect,
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
    id: `box-${machine.id.slice(3)}`,
    label: machine.name.trim() || `Box ${machine.id.slice(3)}`,
    kind: "remote",
    sshEndpoint: `user@${machine.ip}`,
    sshIdentityFile: identityFile,
    sshHostKeyPolicy: "accept-new",
    capabilities: ["terminal", "browser", "herdr", "hermes"],
    appearance: { glyph: "compute-tower" },
  };
};

const isSshUsableState = (state: string): boolean =>
  state === "ready" || state === "idle" || state === "running";

export class BoxOwnershipRepository extends Context.Tag(
  "@vellum/box/BoxOwnershipRepository",
)<
  BoxOwnershipRepository,
  {
    readonly enrollCreated: (
      machine: BoxMachineType,
    ) => Effect.Effect<OwnedBox, BoxOwnershipPersistenceError>;
    readonly requireOwned: (
      boxId: string,
    ) => Effect.Effect<OwnedBox, BoxOwnershipError>;
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
  }
>() {}

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
              `Box ${JSON.stringify(boxId)} is not recorded as Vellum-created; lifecycle access refused`,
          });
        }
        return admitOwnedBox(record satisfies OwnedBoxRecord);
      },
    );

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
            const routeInvalidated =
              row.machine_ip !== machine.ip ||
              !isSshUsableState(machine.state);
            writer.run(
              `UPDATE box_resources
               SET name = ?,
                   machine_ip = ?,
                   machine_state = ?,
                   provider_updated_at = ?,
                   host_id = CASE WHEN ? THEN NULL ELSE host_id END,
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
                routeInvalidated ? 1 : 0,
                routeInvalidated ? 1 : 0,
                routeInvalidated ? 1 : 0,
                machine.id,
              ],
            );
            if (routeInvalidated && row.host_id !== null) {
              writer.run("DELETE FROM host_registry WHERE id = ?", [
                row.host_id,
              ]);
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

    return BoxOwnershipRepository.of({
      enrollCreated,
      requireOwned,
      list,
      updateMachine,
      markSshPrepared,
      enrollVerifiedHost,
    });
  }),
);
