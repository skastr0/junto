// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { spawn } from "node:child_process";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import {
  BOARDING_CHECK_TIMEOUT_MS,
  BOARDING_TIMEOUT_EXIT_CODE,
  type BoardingCheckPlan,
  type BoardingRun,
  boardingReport,
  capOutputTail,
  planFromReadiness,
  renderBoardingTable,
  shapeBoardingResults,
} from "../../shared/boarding";
import { TicketSide } from "../../shared/work-model";
import type { WorkOpName } from "../../shared/work-control";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { InputError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

// `tasks board` — the seat drives the deterministic boarding checks. The CLI
// reads the applicable checklists (source outbound plus chosen destination
// inbound), runs each command in the seat's own environment, and submits what
// it observed. Vellum Command never schedules or runs a check itself, and the
// work service stamps the tickets from these submissions alone.

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const jsonInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const checkTimeoutOption = Flag.integer("check-timeout").pipe(
  Flag.optional,
  Flag.withDescription(
    `Per-check wall clock in ms (default ${BOARDING_CHECK_TIMEOUT_MS})`,
  ),
);

const TasksBoardInput = Schema.Struct({
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  task: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** Destination whose inbound checklist applies — required when it forks. */
  next: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});

/** The slice of the claims read the boarding plan is built from. */
const ClaimsBoardingView = Schema.Struct({
  readiness: Schema.optionalKey(
    Schema.Struct({
      boarding: Schema.Array(
        Schema.Struct({
          destination: Schema.String,
          checks: Schema.Array(
            Schema.Struct({
              checkId: Schema.String,
              side: TicketSide,
              label: Schema.String,
              command: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
});

const call = <A>(op: WorkOpName, item: A, timeout?: number) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, item, timeout);
  });

/** Run one check in the seat's environment; exit 0 is the only green. */
export const runBoardingCheck = (
  check: BoardingCheckPlan,
  timeoutMs: number,
): Effect.Effect<BoardingRun> =>
  Effect.promise(
    () =>
      new Promise<BoardingRun>((resolve) => {
        // The abort signal kills the spawned shell through its own handle —
        // no bare pid ever reaches a signalling call.
        const controller = new AbortController();
        let output = "";
        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        const settle = (exitCode: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            checkId: check.checkId,
            side: check.side,
            exitCode: timedOut ? BOARDING_TIMEOUT_EXIT_CODE : exitCode,
            output: timedOut
              ? capOutputTail(
                  `${output}\n[boarding] check timed out after ${timeoutMs} ms\n`,
                )
              : output,
            ...(timedOut ? { timedOut: true } : {}),
          });
        };
        const child = spawn(check.command, {
          shell: true,
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          signal: controller.signal,
        });
        const append = (chunk: Buffer) => {
          output = capOutputTail(output + chunk.toString("utf8"));
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("error", (error: Error) => {
          if (!timedOut) output = capOutputTail(`${output}\n${error.message}\n`);
          settle(127);
        });
        child.on("close", (code, signal) => {
          settle(code ?? (signal === null ? 1 : 128));
        });
      }),
  );

const planChecks = (
  view: typeof ClaimsBoardingView.Type,
  params: { readonly target: string; readonly next?: string },
) =>
  Effect.gen(function* () {
    const boarding = view.readiness?.boarding ?? [];
    const missingCommand = boarding
      .flatMap((entry) => entry.checks)
      .find((check) => check.command === undefined);
    if (missingCommand !== undefined) {
      return yield* Effect.fail(
        new InputError({
          message: `boarding check "${missingCommand.label}" arrived without its command`,
          path: "tasks.claims",
          next_step:
            "the seat runs the authored command, so the claims read must carry it",
        }),
      );
    }
    const resolved = planFromReadiness({
      from: params.target,
      boarding: boarding.map((entry) => ({
        destination: entry.destination,
        checks: entry.checks.map((check) => ({
          checkId: check.checkId,
          side: check.side,
          label: check.label,
          command: check.command ?? "",
        })),
      })),
      ...(params.next !== undefined ? { next: params.next } : {}),
    });
    if (!resolved.ok) {
      return yield* Effect.fail(
        new InputError({
          message: resolved.rejection.message,
          path: "next",
          next_step: resolved.rejection.next_step,
          received: resolved.rejection.destinations,
        }),
      );
    }
    return resolved.plan;
  });

export const tasksBoardCommand = Command.make(
  "board",
  {
    input: jsonInputArg,
    timeout: timeoutOption,
    checkTimeout: checkTimeoutOption,
  },
  ({ input, timeout, checkTimeout }) =>
    executeJsonCommand(
      "tasks board",
      Effect.gen(function* () {
        const args = yield* loadJsonInput(TasksBoardInput, input);
        const socketTimeout = toUndefined(timeout);
        const perCheck = toUndefined(checkTimeout) ?? BOARDING_CHECK_TIMEOUT_MS;
        if (perCheck <= 0) {
          return yield* Effect.fail(
            new InputError({
              message: "check-timeout must be a positive integer",
              path: "check-timeout",
              received: perCheck,
            }),
          );
        }

        const raw = yield* call(
          "tasks.claims",
          { target: args.target, task: args.task },
          socketTimeout,
        );
        const view = yield* Schema.decodeUnknownEffect(ClaimsBoardingView)(raw).pipe(
          Effect.mapError(
            (error) =>
              new InputError({ message: error.message, path: "tasks.claims" }),
          ),
        );
        const plan = yield* planChecks(view, {
          target: args.target,
          ...(args.next !== undefined ? { next: args.next } : {}),
        });

        // Sequential by design: checks share the seat's working tree.
        const runs = yield* Effect.forEach(
          plan.checks,
          (check) => runBoardingCheck(check, perCheck),
          { concurrency: 1 },
        );
        const report = boardingReport(plan, runs);
        yield* Effect.sync(() => {
          process.stderr.write(`${renderBoardingTable(report)}\n`);
        });

        const results = shapeBoardingResults(plan, runs);
        const stamped = yield* call(
          "tasks.board",
          {
            target: args.target,
            task: args.task,
            next: plan.next,
            results,
          },
          socketTimeout,
        );
        return { ...report, submitted: results.length, stamped };
      }),
    ),
).pipe(
  Command.withDescription(
    "Run this move's boarding checks in the seat environment and submit the results",
  ),
);
