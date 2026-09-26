/**
 * `junto companion-stdio [--device dev_<id>] [--demo]` — the phone end of
 * junto-companion/1 (docs/companion-protocol.md).
 *
 * sshd runs this as the forced command of a paired phone's key: stdin and
 * stdout are the SSH exec channel, NDJSON both ways, nothing on stdout but
 * protocol frames. With `--device`, every request is relayed to the running
 * app over the owner-only operator control socket, which checks the device
 * against the paired-device registry on every call; this process never opens
 * junto.db. With `--demo`, a built-in deterministic canvas answers instead, and
 * neither the app nor ~/.ssh is touched.
 */

import { createInterface } from "node:readline";
import { Effect, Result, Schema } from "effect";
import { makeDemoHost } from "../shared/companion-demo";
import {
  COMPANION_ERROR_COPY,
  CompanionDeviceId,
  companionConnectionErrorLine,
  companionError,
  companionFail,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
} from "../shared/companion-protocol";
import { runCompanionSession, type CompanionChange, type CompanionHost } from "../shared/companion-session";
import {
  OPERATOR_COMPANION_WAIT_MAX_MS,
  OPERATOR_DEFAULT_TIMEOUT_MS,
  type OperatorArgsByOp,
  type OperatorDataByOp,
} from "../shared/operator-control";
import { OperatorSocket, OperatorSocketLive } from "./core/operator-socket";

export const COMPANION_STDIO_COMMAND = "companion-stdio";

export type CompanionStdioArgs =
  | { readonly ok: true; readonly mode: "demo" }
  | { readonly ok: true; readonly mode: "device"; readonly deviceId: string }
  | { readonly ok: false; readonly message: string };

/** `--device dev_<id>` or `--demo` (the demo ignores a device), nothing else. */
export const parseCompanionStdioArgs = (args: ReadonlyArray<string>): CompanionStdioArgs => {
  let demo = false;
  let deviceId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--demo") demo = true;
    else if (arg === "--device") {
      deviceId = args[i + 1];
      i += 1;
    } else if (arg?.startsWith("--device=")) deviceId = arg.slice("--device=".length);
    else return { ok: false, message: `unknown argument ${JSON.stringify(arg)}` };
  }
  if (demo) return { ok: true, mode: "demo" };
  if (deviceId === undefined) return { ok: false, message: "--device dev_<id> or --demo is required" };
  if (Result.isFailure(Schema.decodeUnknownResult(CompanionDeviceId)(deviceId))) {
    return { ok: false, message: "--device is not a device id" };
  }
  return { ok: true, mode: "device", deviceId };
};

type Call = <Op extends "companion.hello" | "companion.call" | "companion.events">(
  op: Op,
  args: OperatorArgsByOp[Op],
  timeoutMs: number,
) => Promise<{ readonly ok: true; readonly data: OperatorDataByOp[Op] } | { readonly ok: false; readonly down: boolean }>;

const operatorCall: Call = (op, args, timeoutMs) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const socket = yield* OperatorSocket;
      return yield* socket.call(op, args, timeoutMs);
    }).pipe(
      Effect.provide(OperatorSocketLive),
      Effect.map((data) => ({ ok: true as const, data })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, down: error._tag === "RuntimeDown" })),
    ),
  );

/** The running app, reached over the operator control socket. */
export const makeRelayHost = (deviceId: string, call: Call = operatorCall): CompanionHost => {
  const unavailable = (id: string): CompanionResponseFrame =>
    companionFail(id, companionError("app-not-running", COMPANION_ERROR_COPY["app-not-running"]));
  return {
    hello: async () => {
      const result = await call("companion.hello", { deviceId }, OPERATOR_DEFAULT_TIMEOUT_MS);
      if (!result.ok) {
        return {
          ok: false,
          error: companionError(
            result.down ? "app-not-running" : "internal",
            COMPANION_ERROR_COPY[result.down ? "app-not-running" : "internal"],
          ),
        };
      }
      return result.data;
    },
    call: async (request: CompanionRequestFrame) => {
      const result = await call("companion.call", { deviceId, request }, OPERATOR_DEFAULT_TIMEOUT_MS);
      if (!result.ok) {
        return result.down ? unavailable(request.id) : companionFail(request.id, companionError("internal", COMPANION_ERROR_COPY.internal));
      }
      return result.data.response;
    },
    waitChange: async (cursor, waitMs): Promise<CompanionChange> => {
      const bounded = Math.max(0, Math.min(OPERATOR_COMPANION_WAIT_MAX_MS, Math.floor(waitMs)));
      const result = await call(
        "companion.events",
        { deviceId, waitMs: bounded, ...(cursor !== undefined ? { cursor } : {}) },
        bounded + 10_000,
      );
      if (!result.ok || !result.data.ok) throw new Error("companion events unavailable");
      const { cursor: next, changed, signals, reset } = result.data;
      return { cursor: next, changed, signals, reset };
    },
  };
};

const stdinLines = (): AsyncIterable<string> =>
  createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });

export const runCompanionStdio = async (args: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseCompanionStdioArgs(args);
  if (!parsed.ok) {
    // Still one protocol frame on stdout, so a phone sees a reason; usage on stderr.
    process.stdout.write(companionConnectionErrorLine("invalid", "This key is not set up for Junto."));
    process.stderr.write(`junto companion-stdio: ${parsed.message}\n`);
    process.exitCode = 64;
    return;
  }
  const host = parsed.mode === "demo" ? makeDemoHost() : makeRelayHost(parsed.deviceId);
  await runCompanionSession({
    lines: stdinLines(),
    write: (line) => {
      process.stdout.write(line);
    },
    host,
  });
  // A long poll may still be in flight; the channel is over.
  process.exit(process.exitCode ?? 0);
};
