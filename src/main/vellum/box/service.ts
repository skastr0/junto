import { Context, Effect, Layer, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BoxCli,
  type BoxAutoStopPolicy,
} from "./cli";
import {
  BoxId,
  type BoxCliAvailability,
  type BoxCliError,
  type BoxMachine,
} from "./domain";
import {
  BoxOwnershipRepository,
  boxHostId,
  type BoxOwnershipError,
  type BoxOwnershipPersistenceError,
  type BoxResource,
} from "./repository";
import {
  inspectOwnedBox,
  type OwnedBox,
} from "./ownership";
import { SettingsService } from "../settings/service";
import { HostsService } from "../hosts/service";
import { parseSshRoute, SshTransport } from "../ssh";

const decodeBoxId = Schema.decodeUnknown(BoxId);

export class BoxFleetValidationError extends Schema.TaggedError<BoxFleetValidationError>()(
  "BoxFleetValidationError",
  {
    detail: Schema.String,
  },
) {}

export class BoxFleetAuthorizationError extends Schema.TaggedError<BoxFleetAuthorizationError>()(
  "BoxFleetAuthorizationError",
  {
    detail: Schema.String,
  },
) {}

export class BoxFleetProvisioningError extends Schema.TaggedError<BoxFleetProvisioningError>()(
  "BoxFleetProvisioningError",
  {
    boxId: BoxId,
    stage: Schema.Literal(
      "record-ownership",
      "prepare-ssh",
      "record-ssh-preparation",
      "verify-openssh",
      "enroll-host",
      "detach",
      "refresh-routing",
    ),
    detail: Schema.String,
  },
) {}

export type BoxFleetError =
  | BoxCliError
  | BoxOwnershipError
  | BoxOwnershipPersistenceError
  | BoxFleetValidationError
  | BoxFleetAuthorizationError
  | BoxFleetProvisioningError;

export interface CreateFleetBoxOptions {
  readonly includeAccountSecrets?: boolean;
}

export const BOX_IDLE_AUTO_STOP_SECONDS = 10 * 60;

export class BoxFleetService extends Context.Tag("@vellum/box/BoxFleetService")<
  BoxFleetService,
  {
    readonly availability: Effect.Effect<BoxCliAvailability>;
    readonly list: Effect.Effect<
      ReadonlyArray<BoxResource>,
      BoxOwnershipPersistenceError
    >;
    readonly create: (
      options?: CreateFleetBoxOptions,
    ) => Effect.Effect<BoxResource, BoxFleetError>;
    readonly refresh: (
      boxId: string,
    ) => Effect.Effect<BoxResource, BoxFleetError>;
    readonly stop: (
      boxId: string,
    ) => Effect.Effect<BoxResource, BoxFleetError>;
    readonly resume: (
      boxId: string,
    ) => Effect.Effect<BoxResource, BoxFleetError>;
    readonly prepareSsh: (
      boxId: string,
    ) => Effect.Effect<BoxResource, BoxFleetError>;
    /**
     * Remove Vellum ownership + fleet host. Provider Box is left alone
     * (stopped/running at account). Use Box dashboard to destroy machines.
     */
    readonly detach: (
      boxId: string,
    ) => Effect.Effect<void, BoxFleetError>;
    /** Pin while active work exists on the host; otherwise arm a provider TTL. */
    readonly setActivityDemand: (
      boxId: string,
      demanded: boolean,
    ) => Effect.Effect<BoxResource, BoxFleetError>;
    /**
     * Refresh provider truth and transparently restore an owned Box route.
     * Non-Box and unowned host identities are deliberately ignored.
     */
    readonly ensureHostAvailable: (
      hostId: string,
    ) => Effect.Effect<BoxResource | undefined, BoxFleetError>;
  }
>() {}

const validationError = (cause: unknown): BoxFleetValidationError =>
  BoxFleetValidationError.make({
    detail:
      cause instanceof Error ? cause.message : "A valid Box id is required",
  });

export interface BoxOpenSshHandoff {
  readonly identityFile: string;
  readonly verify: (machine: BoxMachine) => Effect.Effect<void, unknown>;
  readonly convergeHosts: Effect.Effect<void, unknown>;
}

const defaultHandoff: BoxOpenSshHandoff = {
  identityFile: "/Users/operator/.ssh/ascii_box_ed25519",
  verify: () => Effect.void,
  convergeHosts: Effect.void,
};

const provisioningError = (
  boxId: BoxMachine["id"],
  stage: BoxFleetProvisioningError["stage"],
  cause: unknown,
): BoxFleetProvisioningError =>
  BoxFleetProvisioningError.make({
    boxId,
    stage,
    detail:
      cause &&
      typeof cause === "object" &&
      "detail" in cause &&
      typeof cause.detail === "string"
        ? cause.detail
        : cause instanceof Error
          ? cause.message
          : String(cause),
  });

const sshUsable = (machine: BoxMachine): boolean =>
  machine.ip !== null &&
  (machine.state === "ready" ||
    machine.state === "idle" ||
    machine.state === "running");

export const makeBoxFleetService = (
  cli: Context.Tag.Service<typeof BoxCli>,
  ownership: Context.Tag.Service<typeof BoxOwnershipRepository>,
  authorizeMutation: Effect.Effect<void, BoxFleetAuthorizationError> =
    Effect.void,
  handoff: BoxOpenSshHandoff = defaultHandoff,
): Context.Tag.Service<typeof BoxFleetService> => {
  const activationLocks = new Map<string, Effect.Semaphore>();
  const activationLock = (hostId: string): Effect.Semaphore => {
    const existing = activationLocks.get(hostId);
    if (existing !== undefined) return existing;
    const created = Effect.unsafeMakeSemaphore(1);
    activationLocks.set(hostId, created);
    return created;
  };
  const owned = (boxId: string) =>
    decodeBoxId(boxId).pipe(
      Effect.mapError(validationError),
      Effect.flatMap((id) => ownership.requireOwned(id)),
    );

  const convergeHosts = (boxId: BoxMachine["id"]) =>
    handoff.convergeHosts.pipe(
      Effect.mapError((error) =>
        provisioningError(boxId, "refresh-routing", error),
      ),
    );

  const persistOwned = (
    boxId: string,
    operation: (box: OwnedBox) => Effect.Effect<BoxMachine, BoxCliError>,
  ): Effect.Effect<OwnedBox, BoxFleetError> =>
    authorizeMutation.pipe(
      Effect.andThen(owned(boxId)),
      Effect.flatMap((box) =>
        operation(box).pipe(
          Effect.flatMap((machine) =>
            ownership.updateMachine(box, machine),
          ),
        ),
      ),
      Effect.tap((updated) =>
        convergeHosts(inspectOwnedBox(updated).machine.id),
      ),
    );

  const prepareOwned = (
    box: OwnedBox,
  ): Effect.Effect<BoxResource, BoxFleetError> => {
    const initial = inspectOwnedBox(box);
    return cli.prepareSsh(box).pipe(
      Effect.mapError((error) =>
        provisioningError(initial.machine.id, "prepare-ssh", error),
      ),
      Effect.flatMap(() =>
        ownership.markSshPrepared(box).pipe(
          Effect.mapError((error) =>
            provisioningError(
              initial.machine.id,
              "record-ssh-preparation",
              error,
            ),
          ),
        ),
      ),
      Effect.flatMap((prepared) => {
        const record = inspectOwnedBox(prepared);
        if (!sshUsable(record.machine)) {
          return Effect.fail(
            provisioningError(
              record.machine.id,
              "verify-openssh",
              new Error("Box is not running with an SSH address"),
            ),
          );
        }
        return handoff.verify(record.machine).pipe(
          Effect.mapError((error) =>
            provisioningError(record.machine.id, "verify-openssh", error),
          ),
          Effect.as(prepared),
        );
      }),
      Effect.flatMap((prepared) =>
        ownership
          .enrollVerifiedHost(prepared, handoff.identityFile)
          .pipe(
            Effect.mapError((error) =>
              provisioningError(
                inspectOwnedBox(prepared).machine.id,
                "enroll-host",
                error,
              ),
            ),
          ),
      ),
      Effect.tap((verified) =>
        convergeHosts(inspectOwnedBox(verified).machine.id),
      ),
      Effect.map(inspectOwnedBox),
    );
  };

  const awaitSshUsable = (
    box: OwnedBox,
    attemptsRemaining = 30,
  ): Effect.Effect<OwnedBox, BoxFleetError> => {
    const record = inspectOwnedBox(box);
    if (sshUsable(record.machine)) return Effect.succeed(box);
    if (attemptsRemaining <= 0) {
      return Effect.fail(
        provisioningError(
          record.machine.id,
          "verify-openssh",
          new Error("Box did not become SSH-ready after resume"),
        ),
      );
    }
    return Effect.sleep("2 seconds").pipe(
      Effect.andThen(cli.info(box)),
      Effect.flatMap((machine) => ownership.updateMachine(box, machine)),
      Effect.flatMap((updated) =>
        awaitSshUsable(updated, attemptsRemaining - 1),
      ),
    );
  };

  const activityPolicy = (demanded: boolean): BoxAutoStopPolicy =>
    demanded
      ? { kind: "disabled" }
      : { kind: "ttl", ttlSeconds: BOX_IDLE_AUTO_STOP_SECONDS };

  const ensureHostAvailable = (
    hostId: string,
  ): Effect.Effect<BoxResource | undefined, BoxFleetError> =>
    activationLock(hostId).withPermits(1)(
      ownership.findOwnedByHostId(hostId).pipe(
        Effect.flatMap((candidate) => {
          if (candidate === undefined) return Effect.succeed(undefined);
          return authorizeMutation.pipe(
            Effect.andThen(
              cli.info(candidate).pipe(
                Effect.flatMap((machine) =>
                  ownership.updateMachine(candidate, machine),
                ),
              ),
            ),
            Effect.tap((current) =>
              convergeHosts(inspectOwnedBox(current).machine.id),
            ),
            Effect.flatMap((current) => {
              const record = inspectOwnedBox(current);
              if (
                sshUsable(record.machine) &&
                record.hostId === boxHostId(record.machine.id) &&
                record.sshVerifiedAt !== undefined
              ) {
                return Effect.succeed(record);
              }
              if (sshUsable(record.machine)) return prepareOwned(current);
              return cli.resume(current).pipe(
                Effect.flatMap((machine) =>
                  ownership.updateMachine(current, machine),
                ),
                Effect.flatMap((resumed) => awaitSshUsable(resumed)),
                Effect.tap((resumed) =>
                  convergeHosts(inspectOwnedBox(resumed).machine.id),
                ),
                Effect.flatMap(prepareOwned),
              );
            }),
          );
        }),
      ),
    );

  return BoxFleetService.of({
    availability: cli.availability,
    list: ownership.list,
    create: (options = {}) =>
      authorizeMutation.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            cli
              .create({
                autoStop: {
                  kind: "ttl",
                  ttlSeconds: BOX_IDLE_AUTO_STOP_SECONDS,
                },
                includeAccountSecrets: options.includeAccountSecrets,
              })
              .pipe(
                Effect.flatMap((machine) =>
                  ownership.enrollCreated(machine).pipe(
                    Effect.mapError((error) =>
                      provisioningError(
                        machine.id,
                        "record-ownership",
                        error,
                      ),
                    ),
                  ),
                ),
                Effect.flatMap(prepareOwned),
              ),
          ),
        ),
      ),
    refresh: (boxId) =>
      persistOwned(boxId, (box) => cli.info(box)).pipe(
        Effect.flatMap((updated) => {
          const record = inspectOwnedBox(updated);
          // Re-warm / re-enroll so host_registry tracks provider IP churn.
          if (sshUsable(record.machine)) return prepareOwned(updated);
          return Effect.succeed(record);
        }),
      ),
    stop: (boxId) =>
      persistOwned(boxId, (box) => cli.stop(box)).pipe(
        Effect.map(inspectOwnedBox),
      ),
    resume: (boxId) =>
      persistOwned(boxId, (box) => cli.resume(box)).pipe(
        // Wait through provider restore, then always re-bind OpenSSH route
        // (IPs change on every stop/resume).
        Effect.flatMap((resumed) => awaitSshUsable(resumed)),
        Effect.flatMap((ready) => prepareOwned(ready)),
      ),
    prepareSsh: (boxId) =>
      authorizeMutation.pipe(
        Effect.andThen(owned(boxId)),
        Effect.flatMap(prepareOwned),
      ),
    detach: (boxId) =>
      authorizeMutation.pipe(
        Effect.andThen(owned(boxId)),
        Effect.flatMap((box) => {
          const machineId = inspectOwnedBox(box).machine.id;
          return ownership.detach(box).pipe(
            Effect.mapError((error) =>
              provisioningError(machineId, "detach", error),
            ),
            Effect.zipRight(
              handoff.convergeHosts.pipe(
                Effect.mapError((error) =>
                  provisioningError(machineId, "refresh-routing", error),
                ),
              ),
            ),
          );
        }),
      ),
    setActivityDemand: (boxId, demanded) =>
      authorizeMutation.pipe(
        Effect.andThen(owned(boxId)),
        Effect.flatMap((box) =>
          cli.setAutoStop(box, activityPolicy(demanded)).pipe(
            Effect.as(inspectOwnedBox(box)),
          ),
        ),
      ),
    ensureHostAvailable,
  });
};

export const BoxFleetServiceLive = Layer.effect(
  BoxFleetService,
  Effect.gen(function* () {
    const cli = yield* BoxCli;
    const ownership = yield* BoxOwnershipRepository;
    const settings = yield* SettingsService;
    const ssh = yield* SshTransport;
    const hosts = yield* HostsService;
    const authorizeMutation = settings.get.pipe(
      Effect.flatMap((document) =>
        document.station.role === "command-center"
          ? Effect.void
          : Effect.fail(
              BoxFleetAuthorizationError.make({
                detail:
                  "Only Command Center may operate a Fleet Box",
              }),
            ),
      ),
      Effect.mapError((error) =>
        error instanceof BoxFleetAuthorizationError
          ? error
          : BoxFleetAuthorizationError.make({
              detail:
                error instanceof Error ? error.message : String(error),
            }),
      ),
    );
    const identityFile = join(homedir(), ".ssh", "ascii_box_ed25519");
    return makeBoxFleetService(cli, ownership, authorizeMutation, {
      identityFile,
      verify: (machine) =>
        parseSshRoute({
          endpoint: machine.ip === null ? undefined : `user@${machine.ip}`,
          identityFile,
          hostKeyPolicy: "accept-new",
        }).pipe(Effect.flatMap((route) => ssh.warm(route))),
      // Reload process-local host snapshot after registry mutations so probes
      // and deploy see the new Box IP immediately (not after app restart).
      convergeHosts: hosts.list.pipe(Effect.asVoid),
    });
  }),
);
