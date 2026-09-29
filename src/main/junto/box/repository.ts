import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { RemoteHost } from "@shared/remote-hosts";
import { StateTransactionOperation } from "../state/service";
import { HostRegistryRows } from "../hosts/registry";
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

const BoxResourceRow = Schema.Struct({
  box_id: Schema.String,
  host_id: Schema.NullOr(Schema.String),
  name: Schema.String,
  machine_ip: Schema.NullOr(Schema.String),
  machine_state: Schema.String,
  provider_created_at: Schema.NullOr(Schema.String),
  provider_updated_at: Schema.NullOr(Schema.String),
  ssh_prepared_at: Schema.NullOr(Schema.String),
  ssh_verified_at: Schema.NullOr(Schema.String),
  enrolled_at: Schema.String,
});
type BoxResourceRow = typeof BoxResourceRow.Type;

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
    cause: Schema.Unknown,
  },
) {}

export type BoxOwnershipError =
  | BoxOwnershipNotFoundError
  | BoxOwnershipPersistenceError;

const rowToResource = (row: BoxResourceRow) =>
  Schema.decodeUnknownEffect(BoxResource)({
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

const toPersistenceError = (
  operation: string,
  cause: unknown,
): BoxOwnershipPersistenceError =>
  cause instanceof BoxOwnershipPersistenceError ? cause : BoxOwnershipPersistenceError.make({
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

/** Physical host cleanup, with no dependency on host orchestration. */
export class BoxResourceCleanup extends Context.Service<BoxResourceCleanup, {
  readonly deleteForHost: (hostId: string) => Effect.Effect<void, BoxOwnershipPersistenceError>;
}>()("@junto/box/BoxResourceCleanup") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deleteForHost = Effect.fn("BoxResourceCleanup.deleteForHost")(function* (hostId: string) {
      yield* sql`DELETE FROM box_resources WHERE host_id = ${hostId}`;
    }, Effect.mapError((cause) => toPersistenceError("delete-for-host", cause)));
    return { deleteForHost };
  }));
}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@junto/box/BoxOwnershipRepository` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class BoxOwnershipRepository extends Context.Service<BoxOwnershipRepository, BoxOwnershipRepository>()("@junto/box/BoxOwnershipRepository") {}`
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
     * present in Junto ownership state. Account inventory is never queried.
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
     * the provider Box — only detaches it from Junto.
     */
    readonly detach: (
      box: OwnedBox,
    ) => Effect.Effect<void, BoxOwnershipPersistenceError>;
  }>()("@junto/box/BoxOwnershipRepository") {}

export const BoxOwnershipRepositoryLive = Layer.effect(
  BoxOwnershipRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const hosts = yield* HostRegistryRows;
    const findByBoxId = SqlSchema.findOneOption({
      Request: Schema.String, Result: BoxResourceRow,
      execute: (boxId) => sql`SELECT box_id, host_id, name, machine_ip, machine_state,
        provider_created_at, provider_updated_at, ssh_prepared_at, ssh_verified_at, enrolled_at
        FROM box_resources WHERE box_id = ${boxId}`,
    });
    const selectByBoxId = (boxId: string) => findByBoxId(boxId).pipe(Effect.map(Option.getOrUndefined));
    const findByHostId = SqlSchema.findOneOption({
      Request: Schema.String, Result: BoxResourceRow,
      execute: (hostId) => sql`SELECT box_id, host_id, name, machine_ip, machine_state,
        provider_created_at, provider_updated_at, ssh_prepared_at, ssh_verified_at, enrolled_at
        FROM box_resources WHERE ('box-' || substr(box_id, 4)) = ${hostId}`,
    });
    const selectAll = SqlSchema.findAll({
      Request: Schema.Void, Result: BoxResourceRow,
      execute: () => sql`SELECT box_id, host_id, name, machine_ip, machine_state,
        provider_created_at, provider_updated_at, ssh_prepared_at, ssh_verified_at, enrolled_at
        FROM box_resources ORDER BY enrolled_at, box_id`,
    });

    const enrollCreated = Effect.fn("BoxOwnershipRepository.enrollCreated")(
      function* (machine: BoxMachineType) {
        const enrolledAt = new Date().toISOString();
        const record = yield* sql.withTransaction(Effect.gen(function* () {
            yield* hosts.ensure(enrolledAt);
            const existing = yield* selectByBoxId(machine.id);
            if (existing !== undefined) return yield* rowToResource(existing);
            yield* sql`INSERT INTO box_resources(
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
               ) VALUES (${machine.id}, NULL, ${machine.name}, ${machine.ip}, ${machine.state},
                 ${machine.createdAt}, ${machine.updatedAt}, NULL, NULL, ${enrolledAt})`;
            return {
              machine,
              enrolledAt,
            } satisfies BoxResource;
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "box.ownership.enroll"),
            Effect.mapError((error) =>
              toPersistenceError("enroll-created", error),
            ),
          );
        return admitOwnedBox(record satisfies OwnedBoxRecord);
      },
    );

    const requireOwned = Effect.fn("BoxOwnershipRepository.requireOwned")(
      function* (boxId: string) {
        const record = yield* selectByBoxId(boxId)
          .pipe(Effect.flatMap((row) => row === undefined ? Effect.succeed(undefined) : rowToResource(row)))
          .pipe(
            Effect.mapError((error) =>
              toPersistenceError("require-owned", error),
            ),
          );
        if (record === undefined) {
          return yield* BoxOwnershipNotFoundError.make({
            boxId,
            detail:
              `Box ${JSON.stringify(boxId)} is not recorded as Junto-created; lifecycle access refused`,
          });
        }
        return admitOwnedBox(record satisfies OwnedBoxRecord);
      },
    );

    const findOwnedByHostId = Effect.fn(
      "BoxOwnershipRepository.findOwnedByHostId",
    )(function* (hostId: string) {
      const record = yield* findByHostId(hostId)
        .pipe(Effect.flatMap((row) => Option.isNone(row) ? Effect.succeed(undefined) : rowToResource(row.value)))
        .pipe(
          Effect.mapError((error) =>
            toPersistenceError("find-owned-by-host", error),
          ),
        );
      return record === undefined
        ? undefined
        : admitOwnedBox(record satisfies OwnedBoxRecord);
    });

    const list = selectAll(undefined)
      .pipe(Effect.flatMap((rows) => Effect.forEach(rows, rowToResource)))
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
        const record = yield* sql.withTransaction(Effect.gen(function* () {
            const row = yield* selectByBoxId(machine.id);
            if (row === undefined) {
              return yield* toPersistenceError("update-machine", new Error("Box ownership disappeared during update"));
            }
            // IP churn is normal on stop/resume. Keep the fleet host row and
            // rewrite its OpenSSH endpoint in place — never drop placement.
            const ipChanged =
              row.machine_ip !== machine.ip &&
              machine.ip !== null &&
              machine.ip.trim() !== "";
            // Re-verify only when the route identity changed; stopped state
            // keeps the last endpoint so the host stays visible as unreachable.
            yield* sql`UPDATE box_resources
               SET name = ${machine.name},
                   machine_ip = ${machine.ip},
                   machine_state = ${machine.state},
                   provider_updated_at = ${machine.updatedAt},
                   ssh_prepared_at =
                     CASE WHEN ${ipChanged ? 1 : 0} THEN NULL ELSE ssh_prepared_at END,
                   ssh_verified_at =
                     CASE WHEN ${ipChanged ? 1 : 0} THEN NULL ELSE ssh_verified_at END
               WHERE box_id = ${machine.id}`;
            if (ipChanged && row.host_id !== null) {
              const label = machine.name.trim() || row.name;
              yield* hosts.updateRoute(row.host_id, `user@${machine.ip}`, label);
            }
            const updated = yield* selectByBoxId(machine.id);
            if (updated === undefined) {
              return yield* toPersistenceError("update-machine", new Error("Box ownership disappeared after update"));
            }
            return yield* rowToResource(updated);
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "box.ownership.update-machine"),
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
      const record = yield* sql.withTransaction(Effect.gen(function* () {
          const row = yield* selectByBoxId(current.machine.id);
          if (row === undefined) {
            return yield* toPersistenceError("mark-ssh-prepared", new Error("Box ownership disappeared before SSH preparation"));
          }
          yield* sql`UPDATE box_resources
             SET ssh_prepared_at = ${preparedAt},
                 ssh_verified_at = NULL
             WHERE box_id = ${current.machine.id}`;
          const updated = yield* selectByBoxId(current.machine.id);
          if (updated === undefined) {
            return yield* toPersistenceError("mark-ssh-prepared", new Error("Box ownership disappeared after SSH preparation"));
          }
          return yield* rowToResource(updated);
        }))
        .pipe(
          Effect.provideService(StateTransactionOperation, "box.ownership.mark-ssh-prepared"),
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
      const host = yield* Effect.try({
        try: () => hostForMachine(current.machine, identityFile),
        catch: (cause) => toPersistenceError("enroll-verified-host", cause),
      });
      const verifiedAt = new Date().toISOString();
      const record = yield* sql.withTransaction(Effect.gen(function* () {
          const row = yield* selectByBoxId(current.machine.id);
          if (row === undefined) {
            return yield* toPersistenceError("enroll-verified-host", new Error("Box ownership disappeared before host enrollment"));
          }
          if (row.machine_ip !== current.machine.ip) {
            return yield* toPersistenceError("enroll-verified-host", new Error("Box route changed during OpenSSH verification"));
          }
          yield* hosts.ensure(verifiedAt);
          yield* hosts.upsert(host);
          yield* sql`UPDATE box_resources
             SET host_id = ${host.id},
                 ssh_verified_at = ${verifiedAt}
             WHERE box_id = ${current.machine.id}`;
          const updated = yield* selectByBoxId(current.machine.id);
          if (updated === undefined) {
            return yield* toPersistenceError("enroll-verified-host", new Error("Box ownership disappeared after host enrollment"));
          }
          return yield* rowToResource(updated);
        }))
        .pipe(
          Effect.provideService(StateTransactionOperation, "box.ownership.enroll-verified-host"),
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
      yield* sql.withTransaction(Effect.gen(function* () {
          const row = yield* selectByBoxId(current.machine.id);
          if (row === undefined) {
            return yield* toPersistenceError("detach", new Error("Box ownership disappeared before detach"));
          }
          // box_resources.host_id → host_registry ON DELETE RESTRICT
          if (row.host_id !== null) {
            yield* sql`UPDATE box_resources
               SET host_id = NULL,
                   ssh_prepared_at = NULL,
                   ssh_verified_at = NULL
               WHERE box_id = ${current.machine.id}`;
            yield* hosts.delete(row.host_id);
          }
          yield* sql`DELETE FROM box_resources WHERE box_id = ${current.machine.id}`;
        }))
        .pipe(
          Effect.provideService(StateTransactionOperation, "box.ownership.detach"),
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
).pipe(Layer.provide(HostRegistryRows.layer));
