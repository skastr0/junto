import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  OPERATOR_DEPLOY_TIMEOUT_MS,
  OPERATOR_MAX_PASSWORD_BYTES,
  OPERATOR_SYNC_TIMEOUT_MS,
  type OperatorFleetDeployData,
} from "../../shared/operator-control";
import { InputError, WireError } from "../core/errors";
import { OperatorSocket } from "../core/operator-socket";
import { executeJsonCommand, setExitCode } from "../core/output";

const toUndefined = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

const hostIdArg = Args.text({ name: "id" }).pipe(
  Args.withDescription("Enrolled Vellum host id"),
);

const optionalHostId = Options.text("id").pipe(
  Options.optional,
  Options.withDescription("Restrict the operation to one enrolled host id"),
);

const adminPasswordStdin = Options.boolean("admin-password-stdin").pipe(
  Options.withDescription(
    "After an exact authorization request, read one bounded password line from stdin",
  ),
);

const failWhenDomainFailed = <A extends { readonly ok: boolean }>(value: A) =>
  value.ok
    ? Effect.succeed(value)
    : setExitCode(1).pipe(Effect.as(value));

export type SecretInput = NodeJS.ReadableStream & {
  readonly pause?: () => unknown;
};

/**
 * Read one UTF-8 line after deployment has returned an exact authorization
 * binding. Input is bounded incrementally; every retained Buffer is zeroed on
 * success, failure, and interruption.
 */
export const readAdministratorPasswordLine = (
  stream: SecretInput = process.stdin,
): Effect.Effect<Buffer, InputError> =>
  Effect.async<Buffer, InputError>((resume) => {
    const parts: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const zeroParts = () => {
      for (const part of parts) part.fill(0);
      parts.length = 0;
      totalBytes = 0;
    };

    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      zeroParts();
      stream.pause?.();
      resume(
        Effect.fail(
          new InputError({
            message,
            path: "stdin",
            hint:
              "pipe one password-manager value to stdin; do not place a password in argv or environment variables",
          }),
        ),
      );
    };

    const succeed = (password: Buffer) => {
      if (settled) {
        password.fill(0);
        return;
      }
      settled = true;
      cleanup();
      resume(Effect.succeed(password));
    };

    function onData(chunk: unknown) {
      if (settled) return;
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        fail("administrator password stdin must provide bytes");
        return;
      }
      const source = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const copy = Buffer.from(source);
      source.fill(0);
      if (
        totalBytes + copy.byteLength >
        OPERATOR_MAX_PASSWORD_BYTES + 1
      ) {
        copy.fill(0);
        fail(
          `administrator password stdin exceeds ${OPERATOR_MAX_PASSWORD_BYTES} bytes plus one newline`,
        );
        return;
      }
      parts.push(copy);
      totalBytes += copy.byteLength;
    }

    function onEnd() {
      if (settled) return;
      const collected = Buffer.allocUnsafe(totalBytes);
      let offset = 0;
      for (const part of parts) {
        part.copy(collected, offset);
        offset += part.byteLength;
      }
      zeroParts();

      let contentBytes = collected.byteLength;
      if (contentBytes > 0 && collected[contentBytes - 1] === 0x0a) {
        contentBytes -= 1;
      }
      if (
        contentBytes < 1 ||
        contentBytes > OPERATOR_MAX_PASSWORD_BYTES ||
        collected.subarray(0, contentBytes).some(
          (byte) => byte === 0x00 || byte === 0x0a || byte === 0x0d,
        )
      ) {
        collected.fill(0);
        fail(
          `administrator password stdin must contain one 1-${OPERATOR_MAX_PASSWORD_BYTES} byte line`,
        );
        return;
      }

      const password = Buffer.allocUnsafe(contentBytes);
      collected.copy(password, 0, 0, contentBytes);
      collected.fill(0);
      succeed(password);
    }

    function onError() {
      fail("administrator password could not be read from stdin");
    }

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      cleanup();
      zeroParts();
      stream.pause?.();
    });
  });

export const withAdministratorPasswordLine = <A, E, R>(
  stream: SecretInput,
  use: (password: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InputError, R> =>
  Effect.acquireUseRelease(
    readAdministratorPasswordLine(stream),
    (passwordBytes) =>
      Effect.gen(function* () {
        const password = yield* Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true }).decode(passwordBytes),
          catch: () =>
            new InputError({
              message: "administrator password stdin is not valid UTF-8",
              path: "stdin",
            }),
        });
        // JS strings cannot be zeroized; it is retained only for this one
        // request while its request Buffer is explicitly zeroed by the client.
        return yield* use(password);
      }),
    (passwordBytes) =>
      Effect.sync(() => {
        passwordBytes.fill(0);
      }),
  );

export const runOperatorDeployment = (input: {
  readonly op: "fleet.deploy" | "fleet.qualify";
  readonly id: string;
  readonly source?: "stable" | "cached";
  readonly passwordStdin: boolean;
  readonly passwordInput?: SecretInput;
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
    const first =
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

    if (first.status !== "authorization-required") {
      return yield* failWhenDomainFailed(first);
    }
    if (first.authorizationRequest.hostId !== input.id) {
      return yield* Effect.fail(
        new WireError({
          type: "ProtocolError",
          message: "deployment authorization is bound to a different host",
        }),
      );
    }
    if (!input.passwordStdin) {
      return yield* failWhenDomainFailed(first);
    }

    const retried = yield* withAdministratorPasswordLine(
      input.passwordInput ?? process.stdin,
      (password) =>
        input.op === "fleet.deploy"
          ? socket.call(
              "fleet.deploy",
              {
                id: input.id,
                source: input.source ?? "stable",
                authorization: {
                  request: first.authorizationRequest,
                  password,
                },
              },
              OPERATOR_DEPLOY_TIMEOUT_MS,
            )
          : socket.call(
              "fleet.qualify",
              {
                id: input.id,
                authorization: {
                  request: first.authorizationRequest,
                  password,
                },
              },
              OPERATOR_DEPLOY_TIMEOUT_MS,
            ),
    );
    return yield* failWhenDomainFailed(retried);
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
    adminPasswordStdin,
  },
  ({ id, source, adminPasswordStdin }) =>
    executeJsonCommand(
      "fleet deploy",
      runOperatorDeployment({
        op: "fleet.deploy",
        id,
        source,
        passwordStdin: adminPasswordStdin,
      }),
    ),
).pipe(
  Command.withDescription(
    "Deploy a final-v5 stable or verified-cache release to one Remote",
  ),
);

const fleetQualifyCommand = Command.make(
  "qualify",
  { id: hostIdArg, adminPasswordStdin },
  ({ id, adminPasswordStdin }) =>
    executeJsonCommand(
      "fleet qualify",
      runOperatorDeployment({
        op: "fleet.qualify",
        id,
        passwordStdin: adminPasswordStdin,
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
