// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Command } from "effect/unstable/cli";
import { Effect } from "effect";
import { OperatorSocket } from "../core/operator-socket";
import { executeJsonCommand } from "../core/output";

const stationStatusCommand = Command.make("status", {}, () =>
  executeJsonCommand(
    "station status",
    Effect.gen(function* () {
      const socket = yield* OperatorSocket;
      return yield* socket.call("station.status", {});
    }),
  ),
).pipe(Command.withDescription("Read this installation's Station status"));

const configureCommandCenterCommand = Command.make(
  "configure-command-center",
  {},
  () =>
    executeJsonCommand(
      "station configure-command-center",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call("station.configure-command-center", {});
      }),
    ),
).pipe(
  Command.withDescription(
    "Configure this installation as the canonical local Command Center",
  ),
);

export const stationOperatorCommand = Command.make("station").pipe(
  Command.withDescription("Direct operator Station controls"),
  Command.withSubcommands([
    stationStatusCommand,
    configureCommandCenterCommand,
  ]),
);
