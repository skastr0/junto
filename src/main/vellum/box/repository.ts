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
  hostId: Schema.String,
  enrolledAt: Schema.String,
});
export type BoxResource = typeof BoxResource.Type;

type BoxResourceRow = {
  readonly box_id: string;
  readonly host_id: string;
  readonly name: string;
  readonly machine_ip: string | null;
  readonly machine_state: string;
  readonly provider_created_at: string | null;
  readonly provider_updated_at: string | null;
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
    hostId: row.host_id,
    enrolledAt: row.enrolled_at,
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

const hostForMachine = (machine: BoxMachineType): RemoteHost => {
  if (machine.ip === null || machine.ip.trim() === "") {
    throw new Error(`Box ${machine.id} did not provide an SSH address`);
  }
  return {
    id: `box-${machine.id.slice(3)}`,
    label: machine.name.trim() || `Box ${machine.id.slice(3)}`,
    kind: "remote",
    sshEndpoint: `user@${machine.ip}`,
    capabilities: ["terminal", "browser", "herdr", "hermes"],
    appearance: { glyph: "compute-tower" },
  };
};

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
  }
>() {}

export const BoxOwnershipRepositoryLive = Layer.effect(
  BoxOwnershipRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const enrollCreated = Effect.fn("BoxOwnershipRepository.enrollCreated")(
      function* (machine: BoxMachineType) {
        const host = hostForMachine(machine);
        const enrolledAt = new Date().toISOString();
        const record = yield* state
          .transaction("box.ownership.enroll", (writer) => {
            ensureHostRegistryState(writer, enrolledAt);
            const existing = selectByBoxId(writer, machine.id);
            if (existing !== undefined) return rowToResource(existing);
            upsertHostState(writer, host);
            writer.run(
              `INSERT INTO box_resources(
                 box_id,
                 host_id,
                 name,
                 machine_ip,
                 machine_state,
                 provider_created_at,
                 provider_updated_at,
                 enrolled_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                machine.id,
                host.id,
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
              hostId: host.id,
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
            if (machine.ip !== null && machine.ip.trim() !== "") {
              upsertHostState(writer, {
                ...hostForMachine(machine),
                id: row.host_id,
              });
            }
            writer.run(
              `UPDATE box_resources
               SET name = ?,
                   machine_ip = ?,
                   machine_state = ?,
                   provider_updated_at = ?
               WHERE box_id = ?`,
              [
                machine.name,
                machine.ip,
                machine.state,
                machine.updatedAt,
                machine.id,
              ],
            );
            return {
              machine,
              hostId: row.host_id,
              enrolledAt: row.enrolled_at,
            } satisfies BoxResource;
          })
          .pipe(
            Effect.mapError((error) =>
              toPersistenceError("update-machine", error),
            ),
          );
        return admitOwnedBox(record satisfies OwnedBoxRecord);
      },
    );

    return BoxOwnershipRepository.of({
      enrollCreated,
      requireOwned,
      list,
      updateMachine,
    });
  }),
);
