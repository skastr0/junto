import { access, constants as fsConstants, stat } from "node:fs/promises";
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { WORK_PROTOCOL_VERSION } from "../../shared/work-control";
import { CLI_NAME, CLI_VERSION, DEFAULT_TIMEOUT_MS } from "../core/constants";
import {
  allExamples,
  allSchemas,
  commandCapabilities,
  renderSchemaContract,
} from "../core/discovery";
import { InputError } from "../core/errors";
import { resolveCallerNodeRef } from "../core/node-ref";
import { executeJsonCommand } from "../core/output";
import { WorkSocket, localDoctorChecks } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const timeoutOption = Options.integer("timeout").pipe(
  Options.optional,
  Options.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const targetArg = Args.text({ name: "target" }).pipe(
  Args.withDescription("Schema id, command id, or command name"),
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
        const nodeRef = yield* resolveCallerNodeRef(undefined);
        return yield* socket.call("ping", nodeRef, {}, toUndefined(timeout));
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
          const nodeRefResult = yield* resolveCallerNodeRef(undefined).pipe(Effect.either);
          if (nodeRefResult._tag === "Right") {
            const live = yield* socket
              .call("doctor", nodeRefResult.right, {}, toUndefined(timeout))
              .pipe(Effect.either);
            if (live._tag === "Right") {
              liveOk = true;
              protocol = live.right;
              const version =
                typeof live.right === "object" &&
                live.right !== null &&
                "protocol_version" in live.right
                  ? String((live.right as { protocol_version: string }).protocol_version)
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
                details: { error: live.left.message },
              });
            }
          } else {
            checks.push({
              name: "node_ref",
              ok: false,
              details: {
                hint: "set VELLUM_NODE_REF for full doctor",
                error: nodeRefResult.left.message,
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
        const nodeRef = yield* resolveCallerNodeRef(undefined);
        // Live wiring from edges — daemon computes from document state.
        return yield* socket.call("capabilities", nodeRef, {}, toUndefined(timeout));
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
        const nodeRef = yield* resolveCallerNodeRef(undefined);
        return yield* socket.call("onboard", nodeRef, {}, toUndefined(timeout));
      }),
    ),
).pipe(Command.withDescription("Onboard briefing from live document state"));

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
