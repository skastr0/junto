import { spawn } from "node:child_process";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import {
  CHECK_TIMEOUT_EXIT_CODE,
  CHECK_TIMEOUT_MS,
  capOutputTail,
  checkReport,
  planFromReadiness,
  shapeCheckResults,
  type CheckPlanItem,
  type CheckRun,
} from "../../shared/checks";
import {
  TasksCheckCliArgs,
  TasksRulesArgs,
  TasksRulesView,
  type WorkOpName,
} from "../../shared/work-control";
import { InputError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;
const inputArg = Argument.string("input");
const timeout = Flag.integer("timeout").pipe(Flag.optional);
const checkTimeout = Flag.integer("check-timeout").pipe(Flag.optional);

const call = <A>(op: WorkOpName, item: A, timeoutMs?: number) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, item, timeoutMs);
  });

export const runCheck = (
  check: CheckPlanItem,
  timeoutMs: number,
): Effect.Effect<CheckRun> =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
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
            exitCode: timedOut ? CHECK_TIMEOUT_EXIT_CODE : exitCode,
            output: timedOut
              ? `${output}\n[check] timed out after ${timeoutMs} ms\n`
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
        child.on("error", (error) => {
          if (!timedOut) output += `\n${error.message}\n`;
          settle(127);
        });
        child.on("close", (code, signal) =>
          settle(code ?? (signal === null ? 1 : 128)),
        );
      }),
  );

export const tasksCheckCommand = Command.make("check", {
  input: inputArg,
  timeout,
  checkTimeout,
}, ({ input, timeout, checkTimeout }) =>
  executeJsonCommand(
    "tasks check",
    Effect.gen(function* () {
      const args = yield* loadJsonInput(TasksCheckCliArgs, input);
      const socketTimeout = toUndefined(timeout);
      const perCheck = toUndefined(checkTimeout) ?? CHECK_TIMEOUT_MS;
      if (perCheck <= 0) {
        return yield* Effect.fail(
          new InputError({
            message: "check-timeout must be positive",
            path: "check-timeout",
          }),
        );
      }
      const rawRules = yield* call(
        "tasks.rules",
        TasksRulesArgs.make({ target: args.target, task: args.task }),
        socketTimeout,
      );
      const rules = yield* Schema.decodeUnknownEffect(TasksRulesView)(rawRules).pipe(
        Effect.mapError(
          (error) =>
            new InputError({
              message: error.message,
              path: "tasks.rules",
            }),
        ),
      );
      if (rules.readiness === undefined) {
        return yield* Effect.fail(
          new InputError({
            message: "tasks.rules did not include task readiness",
            path: "tasks.rules.readiness",
          }),
        );
      }
      const resolved = planFromReadiness({
        from: args.target,
        checks: rules.readiness.checks,
        ...(args.next ? { next: args.next } : {}),
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
      const runs = yield* Effect.forEach(
        resolved.plan.checks,
        (check) => runCheck(check, perCheck),
        { concurrency: 1 },
      );
      const results = shapeCheckResults(resolved.plan, runs);
      const stamped = yield* call(
        "tasks.check",
        {
          target: args.target,
          task: args.task,
          next: resolved.plan.next,
          results,
        },
        socketTimeout,
      );
      return {
        ...checkReport(resolved.plan, runs),
        submitted: results.length,
        stamped,
      };
    }),
  ),
);
