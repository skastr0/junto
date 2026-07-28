import { Context, Effect, Layer, Schema } from "effect";
import { BoxCli } from "./cli";
import {
  BoxId,
  type BoxCliAvailability,
  type BoxCliError,
  type BoxMachine,
} from "./domain";
import {
  BoxOwnershipRepository,
  type BoxOwnershipError,
  type BoxOwnershipPersistenceError,
  type BoxResource,
} from "./repository";
import {
  inspectOwnedBox,
  type OwnedBox,
} from "./ownership";

const decodeBoxId = Schema.decodeUnknown(BoxId);

export class BoxFleetValidationError extends Schema.TaggedError<BoxFleetValidationError>()(
  "BoxFleetValidationError",
  {
    detail: Schema.String,
  },
) {}

export type BoxFleetError =
  | BoxCliError
  | BoxOwnershipError
  | BoxOwnershipPersistenceError
  | BoxFleetValidationError;

export interface CreateFleetBoxOptions {
  readonly includeAccountSecrets?: boolean;
}

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
    readonly ssh: (
      boxId: string,
      command: ReadonlyArray<string>,
    ) => Effect.Effect<string, BoxFleetError>;
  }
>() {}

const validationError = (cause: unknown): BoxFleetValidationError =>
  BoxFleetValidationError.make({
    detail:
      cause instanceof Error ? cause.message : "A valid Box id is required",
  });

export const makeBoxFleetService = (
  cli: Context.Tag.Service<typeof BoxCli>,
  ownership: Context.Tag.Service<typeof BoxOwnershipRepository>,
): Context.Tag.Service<typeof BoxFleetService> => {
  const owned = (boxId: string) =>
    decodeBoxId(boxId).pipe(
      Effect.mapError(validationError),
      Effect.flatMap((id) => ownership.requireOwned(id)),
    );

  const persist = (
    boxId: string,
    operation: (box: OwnedBox) => Effect.Effect<BoxMachine, BoxCliError>,
  ): Effect.Effect<BoxResource, BoxFleetError> =>
    owned(boxId).pipe(
      Effect.flatMap((box) =>
        operation(box).pipe(
          Effect.flatMap((machine) =>
            ownership.updateMachine(box, machine).pipe(
              Effect.map((updated) => inspectOwnedBox(updated)),
            ),
          ),
        ),
      ),
    );

  return BoxFleetService.of({
    availability: cli.availability,
    list: ownership.list,
    create: (options = {}) =>
      cli
        .create({
          autoStop: false,
          includeAccountSecrets: options.includeAccountSecrets,
        })
        .pipe(
          // A created machine is not returned to product callers until the
          // ownership record and Fleet host are one committed transaction.
          Effect.flatMap((machine) => ownership.enrollCreated(machine)),
          Effect.map((box) => inspectOwnedBox(box)),
        ),
    refresh: (boxId) => persist(boxId, (box) => cli.info(box)),
    stop: (boxId) => persist(boxId, (box) => cli.stop(box)),
    resume: (boxId) => persist(boxId, (box) => cli.resume(box)),
    ssh: (boxId, command) =>
      owned(boxId).pipe(Effect.flatMap((box) => cli.ssh(box, command))),
  });
};

export const BoxFleetServiceLive = Layer.effect(
  BoxFleetService,
  Effect.gen(function* () {
    const cli = yield* BoxCli;
    const ownership = yield* BoxOwnershipRepository;
    return makeBoxFleetService(cli, ownership);
  }),
);
