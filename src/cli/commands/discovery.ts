import { access, constants as fsConstants, stat } from "node:fs/promises";
// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import { WORK_PROTOCOL_VERSION } from "../../shared/work-control";
import { CLI_NAME, CLI_VERSION, DEFAULT_TIMEOUT_MS } from "../core/constants";
import {
  allExamples,
  allSchemas,
  annotateCapabilityInvocations,
  commandCapabilities,
  renderSchemaContract,
} from "../core/discovery";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";
import { WorkSocket, localDoctorChecks } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const targetArg = Argument.string("target").pipe(
  Argument.withDescription("Schema id, command id, or command name"),
);

const matchesTarget = (
  target: string,
  entry: { readonly command_id: string; readonly command: string; readonly schema_id?: string },
) => {
  const normalized = target.trim();
  return (
    entry.command_id === normalized ||
    entry.command === normalized ||
    entry.schema_id === normalized
  );
};

const modeOctal = (mode: number | null): string | null =>
  mode === null ? null : mode.toString(8).padStart(3, "0");

export const pingCommand = Command.make(
  "ping",
  { timeout: timeoutOption },
  ({ timeout }) =>
    executeJsonCommand(
      "ping",
      Effect.gen(function* () {
        const socket = yield* WorkSocket;
        return yield* socket.call("ping", {}, toUndefined(timeout));
      }),
    ),
).pipe(Command.withDescription("Liveness probe against the work control socket"));

export const doctorCommand = Command.make(
  "doctor",
  { timeout: timeoutOption },
  ({ timeout }) =>
    executeJsonCommand(
      "doctor",
      Effect.gen(function* () {
        const local = yield* localDoctorChecks;
        const checks: Array<{ name: string; ok: boolean; details: unknown }> = [
          {
            name: "work.socket",
            ok: local.socket_present,
            details: {
              path: local.socket_path,
              mode: modeOctal(local.socket_mode),
              required_mode: "600",
            },
          },
          {
            name: "work.token",
            ok: local.token_present,
            details: {
              path: local.token_path,
              mode: modeOctal(local.token_mode),
              required_mode: "600",
            },
          },
          {
            name: "work.socket.perms",
            ok: !local.socket_present || local.socket_mode_ok,
            details: { mode: modeOctal(local.socket_mode) },
          },
          {
            name: "work.token.perms",
            ok: !local.token_present || local.token_mode_ok,
            details: { mode: modeOctal(local.token_mode) },
          },
        ];

        let protocol: unknown = null;
        let liveOk = false;
        if (local.socket_present && local.token_present) {
          const socket = yield* WorkSocket;
          const live = yield* socket
            .call("doctor", {}, toUndefined(timeout))
            .pipe(Effect.result);
          if (live._tag === "Success") {
            liveOk = true;
            protocol = live.success;
            const version =
              typeof live.success === "object" &&
              live.success !== null &&
              "protocol_version" in live.success
                ? String((live.success as { protocol_version: string }).protocol_version)
                : undefined;
            checks.push({
              name: "protocol.version",
              ok: version === WORK_PROTOCOL_VERSION,
              details: {
                expected: WORK_PROTOCOL_VERSION,
                received: version,
              },
            });
          } else {
            checks.push({
              name: "protocol.live",
              ok: false,
              details: {
                error: live.failure.message,
                hint: "CLI must run under a live Junto agent process (process-bind)",
              },
            });
          }
        }

        // Token must never appear in the report.
        return {
          cli: { name: CLI_NAME, version: CLI_VERSION },
          protocol_version: WORK_PROTOCOL_VERSION,
          status: checks.every((c) => c.ok) && liveOk ? "ok" : "attention_required",
          checks,
          live: protocol,
        };
      }),
    ),
).pipe(Command.withDescription("Inspect work control env, perms, protocol"));

export const capabilitiesCommand = Command.make(
  "capabilities",
  { timeout: timeoutOption },
  ({ timeout }) =>
    executeJsonCommand(
      "capabilities",
      Effect.gen(function* () {
        const socket = yield* WorkSocket;
        // Live wiring from edges — daemon uses process-bound caller.
        return annotateCapabilityInvocations(
          yield* socket.call("capabilities", {}, toUndefined(timeout)),
        );
      }),
    ),
).pipe(Command.withDescription("Live edge wiring as a contract"));

export const onboardCommand = Command.make(
  "onboard",
  { timeout: timeoutOption },
  ({ timeout }) =>
    executeJsonCommand(
      "onboard",
      Effect.gen(function* () {
        const socket = yield* WorkSocket;
        return annotateCapabilityInvocations(
          yield* socket.call("onboard", {}, toUndefined(timeout)),
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "Seat orientation: node, region briefing (instruction), edges, co-members",
  ),
);

const schemaListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "schema list",
    Effect.succeed({
      schemas: allSchemas.map((schema) => ({
        command_id: schema.command_id,
        command: schema.command,
        schema_id: schema.schema_id,
        description: schema.description,
        accepts_batch: schema.accepts_batch ?? false,
      })),
    }),
  ),
).pipe(Command.withDescription("List JSON input schemas"));

const schemaShowCommand = Command.make("show", { target: targetArg }, ({ target }) =>
  executeJsonCommand(
    "schema show",
    Effect.gen(function* () {
      const schema = allSchemas.find((entry) => matchesTarget(target, entry));
      if (!schema) {
        return yield* Effect.fail(
          new InputError({ message: `No schema found for ${target}`, path: "target" }),
        );
      }
      return renderSchemaContract(schema);
    }),
  ),
).pipe(Command.withDescription("Show one JSON input schema"));

export const schemaCommand = Command.make("schema").pipe(
  Command.withDescription("Schema discovery"),
  Command.withSubcommands([schemaListCommand, schemaShowCommand]),
);

const examplesListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "examples list",
    Effect.succeed({
      examples: allExamples.map((example) => ({
        command_id: example.command_id,
        command: example.command,
        name: example.name,
        ...(example.description ? { description: example.description } : {}),
      })),
    }),
  ),
).pipe(Command.withDescription("List executable examples"));

const examplesShowCommand = Command.make("show", { target: targetArg }, ({ target }) =>
  executeJsonCommand(
    "examples show",
    Effect.gen(function* () {
      const examples = allExamples.filter((entry) => matchesTarget(target, entry));
      const first = examples[0];
      if (!first) {
        return yield* Effect.fail(
          new InputError({ message: `No examples found for ${target}`, path: "target" }),
        );
      }
      return {
        command_id: first.command_id,
        command: first.command,
        examples: examples.map((example) => ({
          name: example.name,
          ...(example.description ? { description: example.description } : {}),
          ...(example.args ? { args: example.args } : {}),
          ...(example.input !== undefined ? { input: example.input } : {}),
        })),
      };
    }),
  ),
).pipe(Command.withDescription("Show examples for one command"));

export const examplesCommand = Command.make("examples").pipe(
  Command.withDescription("Example discovery"),
  Command.withSubcommands([examplesListCommand, examplesShowCommand]),
);

// Static CLI capability catalog (not live edges — use `capabilities` for that).
export const staticCapabilitiesData = {
  cli: { name: CLI_NAME, version: CLI_VERSION },
  protocol_version: WORK_PROTOCOL_VERSION,
  input_modes: ["inline-json", "@file", "stdin"],
  output: {
    success: { stream: "stdout", envelope: "{ ok: true, command, data }" },
    failure: { stream: "stderr", envelope: "{ ok: false, command, error }" },
  },
  batch: {
    outcome_values: ["succeeded", "partial_failure", "failed"],
    default_concurrency: 5,
    partial_failure_exit_code: 1,
  },
  commands: commandCapabilities,
};

// Silence unused imports kept for possible doctor fs probes
void access;
void fsConstants;
void stat;
