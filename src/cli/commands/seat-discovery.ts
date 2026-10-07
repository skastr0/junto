// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import { WORK_PROTOCOL_VERSION, WORK_TOKEN_ENV } from "../../shared/work-control";
import { ONBOARD_PAST_NOTES_DEFAULT, ONBOARD_PAST_NOTES_MAX } from "../../shared/seat-sessions";
import { loadOffboardArgs } from "../core/offboard-input";
import { CLI_NAME, CLI_VERSION, DEFAULT_TIMEOUT_MS } from "../core/constants";
import {
  annotateCapabilityInvocations,
} from "../core/capability-invocations";
import { executeJsonCommand } from "../core/output";
import { WorkSocket, localDoctorChecks } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

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
            name: "work.credential",
            ok: local.credential_present && local.credential_shape_ok,
            details: {
              present: local.credential_present,
              shape_ok: local.credential_shape_ok,
              source: WORK_TOKEN_ENV,
            },
          },
          {
            name: "work.socket.perms",
            ok: !local.socket_present || local.socket_mode_ok,
            details: { mode: modeOctal(local.socket_mode) },
          },
        ];

        let protocol: unknown = null;
        let liveOk = false;
        if (local.socket_present && local.credential_present) {
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
                hint: "CLI must run inside a live Junto seat with its generation credential",
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

const pastNotesOption = Flag.integer("past-notes").pipe(
  Flag.optional,
  Flag.withDescription(
    `How many of this seat's latest offboard notes to include inline (default ${ONBOARD_PAST_NOTES_DEFAULT}, at most ${ONBOARD_PAST_NOTES_MAX})`,
  ),
);

export const onboardCommand = Command.make(
  "onboard",
  { pastNotes: pastNotesOption, timeout: timeoutOption },
  ({ pastNotes, timeout }) =>
    executeJsonCommand(
      "onboard",
      Effect.gen(function* () {
        const socket = yield* WorkSocket;
        const args = Option.isSome(pastNotes) ? { past_notes: pastNotes.value } : {};
        // Onboard already carries the commands each connection allows,
        // compiled by the daemon from held ports (`instructions`).
        return yield* socket.call("onboard", args, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Load this seat: guidance, region briefing, connections and the commands each allows, past sessions",
  ),
);

export const offboardCommand = Command.make(
  "offboard",
  {
    notes: Argument.string("notes").pipe(
      Argument.withDescription(
        'Markdown notes on this session: inline, @file, - for stdin, or {"notes":"..."}. First line sums it up.',
      ),
    ),
    continuation: Flag.string("continue").pipe(
      Flag.optional,
      Flag.withDescription(
        "Continue in a fresh session: a note for it, what to pick up and why (inline, @file, or - for stdin). Junto starts that session right away.",
      ),
    ),
    timeout: timeoutOption,
  },
  ({ notes, continuation, timeout }) =>
    executeJsonCommand(
      "offboard",
      Effect.gen(function* () {
        const socket = yield* WorkSocket;
        const args = yield* loadOffboardArgs(notes, toUndefined(continuation));
        return yield* socket.call("offboard", args, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    [
      "End this session with notes on what happened, what is relevant, and why it matters. You choose the stopping point. Run it last: the moment it returns, your seat has moved on to a fresh session. This session may finish what it is saying, but it receives nothing more and its junto commands are refused.",
      "At a stopping point: junto offboard \"<notes>\". The seat rests; its next wake starts a fresh session that reads your notes.",
      "Mid-work: junto offboard \"<notes>\" --continue \"<note>\". Junto starts the fresh session right away, and it reads your note first and carries on.",
    ].join(" "),
  ),
);

