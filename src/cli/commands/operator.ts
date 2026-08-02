// S7: @effect/cli → effect/unstable/cli/* on V4 pin (Args→Argument, Options→Flag). Map: ../effect-v4-import-map.ts
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  OPERATOR_DEPLOY_TIMEOUT_MS,
  OPERATOR_SYNC_TIMEOUT_MS,
  type OperatorFleetDeployData,
} from "../../shared/operator-control";
import { InputError, WireError } from "../core/errors";
import { OperatorSocket } from "../core/operator-socket";
import { executeJsonCommand, setExitCode } from "../core/output";

const toUndefined = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

const hostIdArg = Args.text({ name: "id" }).pipe(
  Args.withDescription("Enrolled Vellum Command host id"),
);

const optionalHostId = Options.text("id").pipe(
  Options.optional,
  Options.withDescription("Restrict the operation to one enrolled host id"),
);

const failWhenDomainFailed = <A extends { readonly ok: boolean }>(value: A) =>
  value.ok
    ? Effect.succeed(value)
    : setExitCode(1).pipe(Effect.as(value));

export const runOperatorDeployment = (input: {
  readonly op: "fleet.deploy" | "fleet.qualify";
  readonly id: string;
  readonly source?: "stable" | "cached";
}): Effect.Effect<
  OperatorFleetDeployData,
  | InputError
  | WireError
  | import("../core/errors").RuntimeDown
  | import("../core/errors").AuthError,
  OperatorSocket
> =>
  Effect.gen(function* () {
    const socket = yield* OperatorSocket;
    const result =
      input.op === "fleet.deploy"
        ? yield* socket.call(
            "fleet.deploy",
            {
              id: input.id,
              source: input.source ?? "stable",
            },
            OPERATOR_DEPLOY_TIMEOUT_MS,
          )
        : yield* socket.call(
            "fleet.qualify",
            { id: input.id },
            OPERATOR_DEPLOY_TIMEOUT_MS,
          );

    return yield* failWhenDomainFailed(result);
  });

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

const fleetListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "fleet list",
    Effect.gen(function* () {
      const socket = yield* OperatorSocket;
      return yield* socket.call("fleet.list", {});
    }),
  ),
).pipe(Command.withDescription("List enrolled hosts"));

const capabilityOption = Options.choice("capability", [
  "terminal",
  "browser",
  "hermes",
  "herdr",
] as const).pipe(
  Options.repeated,
  Options.withDescription(
    "Repeat for each admitted host capability: terminal, browser, hermes, herdr",
  ),
);

const fleetAddCommand = Command.make(
  "add",
  {
    id: Options.text("id"),
    label: Options.text("label"),
    sshEndpoint: Options.text("ssh-endpoint"),
    capabilities: capabilityOption,
  },
  ({ id, label, sshEndpoint, capabilities }) =>
    executeJsonCommand(
      "fleet add",
      Effect.gen(function* () {
        if (capabilities.length === 0) {
          return yield* Effect.fail(
            new InputError({
              message: "at least one --capability is required",
              path: "capability",
            }),
          );
        }
        const socket = yield* OperatorSocket;
        return yield* socket.call("fleet.add", {
          id,
          label,
          sshEndpoint,
          capabilities,
        });
      }),
    ),
).pipe(Command.withDescription("Enroll one bounded SSH Remote"));

const fleetTestCommand = Command.make(
  "test",
  { id: hostIdArg },
  ({ id }) =>
    executeJsonCommand(
      "fleet test",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* failWhenDomainFailed(
          yield* socket.call("fleet.test", { id }),
        );
      }),
    ),
).pipe(Command.withDescription("Test one enrolled Remote"));

const enableManagedInstallsCommand = Command.make(
  "enable-managed-installs",
  {},
  () =>
    executeJsonCommand(
      "fleet enable-managed-installs",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call("fleet.enable-managed-installs", {});
      }),
    ),
).pipe(
  Command.withDescription(
    "Enable the operator kill-switch for managed Remote installs",
  ),
);

const fleetDeployCommand = Command.make(
  "deploy",
  {
    id: hostIdArg,
    source: Options.choice("source", ["stable", "cached"] as const),
  },
  ({ id, source }) =>
    executeJsonCommand(
      "fleet deploy",
      runOperatorDeployment({
        op: "fleet.deploy",
        id,
        source,
      }),
    ),
).pipe(
  Command.withDescription(
    "Deploy a final-v5 stable or verified-cache release to one Remote",
  ),
);

const fleetQualifyCommand = Command.make(
  "qualify",
  { id: hostIdArg },
  ({ id }) =>
    executeJsonCommand(
      "fleet qualify",
      runOperatorDeployment({
        op: "fleet.qualify",
        id,
      }),
    ),
).pipe(
  Command.withDescription(
    "Deploy the domain-separated signed qualification candidate to one Remote",
  ),
);

const fleetSyncCommand = Command.make(
  "sync",
  { id: optionalHostId },
  ({ id }) =>
    executeJsonCommand(
      "fleet sync",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        const selectedId = toUndefined(id);
        const data = yield* socket.call(
          "fleet.sync",
          selectedId === undefined ? {} : { id: selectedId },
          OPERATOR_SYNC_TIMEOUT_MS,
        );
        return data.results.some((result) => !result.ok)
          ? yield* setExitCode(1).pipe(Effect.as(data))
          : data;
      }),
    ),
).pipe(Command.withDescription("Await one bounded fleet reconciliation"));

const fleetStatusCommand = Command.make(
  "status",
  { id: optionalHostId },
  ({ id }) =>
    executeJsonCommand(
      "fleet status",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        const selectedId = toUndefined(id);
        return yield* socket.call(
          "fleet.status",
          selectedId === undefined ? {} : { id: selectedId },
        );
      }),
    ),
).pipe(Command.withDescription("Read persistent fleet supervisor status"));

export const fleetOperatorCommand = Command.make("fleet").pipe(
  Command.withDescription("Direct operator fleet controls"),
  Command.withSubcommands([
    fleetListCommand,
    fleetAddCommand,
    fleetTestCommand,
    enableManagedInstallsCommand,
    fleetDeployCommand,
    fleetQualifyCommand,
    fleetSyncCommand,
    fleetStatusCommand,
  ]),
);

const qualificationRunId = Options.text("run-id").pipe(
  Options.withDescription("Short qualification run id"),
);

const qualificationHostId = Options.text("host-id").pipe(
  Options.withDescription("Exact enrolled Remote host id"),
);

const qualificationWorkPrepareCommand = Command.make(
  "prepare",
  {
    runId: qualificationRunId,
    hostId: qualificationHostId,
  },
  ({ runId, hostId }) =>
    executeJsonCommand(
      "qualification work prepare",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call(
          "qualification.work.prepare",
          { runId, hostId },
          OPERATOR_SYNC_TIMEOUT_MS,
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "Create, claim, and synchronize the fixed qualification task",
  ),
);

const qualificationWorkProgressOfflineCommand = Command.make(
  "progress-offline",
  { runId: qualificationRunId },
  ({ runId }) =>
    executeJsonCommand(
      "qualification work progress-offline",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call(
          "qualification.work.progress-offline",
          { runId },
          OPERATOR_SYNC_TIMEOUT_MS,
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "Complete the fixed qualification task while the Command Center session is absent",
  ),
);

const qualificationWorkVerifyCommand = Command.make(
  "verify",
  {
    runId: qualificationRunId,
    hostId: qualificationHostId,
  },
  ({ runId, hostId }) =>
    executeJsonCommand(
      "qualification work verify",
      Effect.gen(function* () {
        const socket = yield* OperatorSocket;
        return yield* socket.call(
          "qualification.work.verify",
          { runId, hostId },
          OPERATOR_SYNC_TIMEOUT_MS,
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "Reconcile and verify the fixed qualification task on Command Center",
  ),
);

export const qualificationWorkOperatorCommand = Command.make("work").pipe(
  Command.withDescription("Closed two-installation work qualification"),
  Command.withSubcommands([
    qualificationWorkPrepareCommand,
    qualificationWorkProgressOfflineCommand,
    qualificationWorkVerifyCommand,
  ]),
);

export const qualificationOperatorCommand = Command.make(
  "qualification",
).pipe(
  Command.withDescription("Direct operator release qualification controls"),
  Command.withSubcommands([qualificationWorkOperatorCommand]),
);
