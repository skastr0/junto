/**
 * `junto companion-stdio [--device dev_<id>] [--demo]` — the phone end of
 * junto-companion/1 (docs/companion-protocol.md).
 *
 * sshd runs this as the forced command of a paired phone's key: stdin and
 * stdout are the SSH exec channel, NDJSON both ways, nothing on stdout but
 * protocol frames. With `--device`, every request is relayed to the running
 * app over the owner-only operator control socket, which checks the device
 * against the paired-device registry on every call; this process never opens
 * junto.db. When the app is not running, the installed Junto is started and the
 * hello waits up to 20 seconds for it (companion-launch.ts). With `--demo`, a
 * built-in deterministic canvas answers instead, and neither the app nor ~/.ssh
 * is touched.
 */

import { Effect, Result, Schema } from "effect";
import { makeDemoHost } from "../shared/companion-demo";
import { rasterizePortraitSvg } from "../main/junto/companion/portrait-png";
import { defaultMachineName } from "../shared/machine-name";
import {
  COMPANION_ERROR_COPY,
  COMPANION_MAX_INBOUND_BYTES,
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
  OPERATOR_PEER_LIMIT_MESSAGE,
  type OperatorArgsByOp,
  type OperatorDataByOp,
} from "../shared/operator-control";
import {
  COMPANION_LAUNCH_POLL_MS,
  COMPANION_LAUNCH_WAIT_MS,
  launchInstalledJunto,
} from "./companion-launch";
import { OperatorSocket, OperatorSocketLive } from "./core/operator-socket";

export { COMPANION_STDIO_COMMAND } from "./protocol-command-names";

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
) => Promise<
  | { readonly ok: true; readonly data: OperatorDataByOp[Op] }
  /** busy: every operator control slot was taken; the app is up. */
  | { readonly ok: false; readonly down: boolean; readonly busy?: boolean }
>;

const operatorCall: Call = (op, args, timeoutMs) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const socket = yield* OperatorSocket;
      return yield* socket.call(op, args, timeoutMs);
    }).pipe(
      Effect.provide(OperatorSocketLive),
      Effect.map((data) => ({ ok: true as const, data })),
      Effect.catch((error) => {
        const busy = error._tag === "RuntimeDown" && error.message === OPERATOR_PEER_LIMIT_MESSAGE;
        return Effect.succeed({ ok: false as const, down: error._tag === "RuntimeDown" && !busy, ...(busy ? { busy } : {}) });
      }),
    ),
  );

/** Starts the installed app when the hello finds it down; seams for tests. */
export type Wake = {
  readonly launch: () => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The default: start nothing. Only the forced command itself passes `wakeInstalledApp`. */
const neverWake: Wake = { launch: async () => false, now: Date.now, sleep };

export const wakeInstalledApp: Wake = { launch: launchInstalledJunto, now: Date.now, sleep };

/**
 * Requests one phone relays over the operator control socket at once; the
 * rest wait their turn. With the long poll that is four of the socket's
 * eight peers, so two phones fit, and a burst queues instead of failing.
 */
export const COMPANION_RELAY_CALLS_MAX = 3;

const BUSY = "Junto on the Mac is busy. Try again in a moment.";

/** At most `max` at once, first come first served. */
const makeTurns = (max: number) => {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <A>(run: () => Promise<A>): Promise<A> => {
    if (running >= max) await new Promise<void>((turn) => waiting.push(turn));
    else running += 1;
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next !== undefined) next();
      else running -= 1;
    }
  };
};

/** The running app, reached over the operator control socket. */
export const makeRelayHost = (deviceId: string, call: Call = operatorCall, wake: Wake = neverWake): CompanionHost => {
  const unavailable = (id: string): CompanionResponseFrame =>
    companionFail(id, companionError("app-not-running", COMPANION_ERROR_COPY["app-not-running"]));
  const turn = makeTurns(COMPANION_RELAY_CALLS_MAX);
  return {
    hello: async () => {
      let result = await call("companion.hello", { deviceId }, OPERATOR_DEFAULT_TIMEOUT_MS);
      // Not running: start the installed app once, then ask again until its
      // socket answers or the wait runs out, and answer as today after that.
      if (!result.ok && result.down && (await wake.launch().catch(() => false))) {
        const deadline = wake.now() + COMPANION_LAUNCH_WAIT_MS;
        while (!result.ok && result.down && wake.now() < deadline) {
          await wake.sleep(Math.min(COMPANION_LAUNCH_POLL_MS, Math.max(0, deadline - wake.now())));
          const left = deadline - wake.now();
          if (left <= 0) break;
          result = await call("companion.hello", { deviceId }, left);
        }
      }
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
      const result = await turn(() => call("companion.call", { deviceId, request }, OPERATOR_DEFAULT_TIMEOUT_MS));
      if (!result.ok) {
        if (result.busy === true) return companionFail(request.id, companionError("rate-limited", BUSY));
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

/**
 * Lines of `input`, none held past `max` bytes counting its newline: a line
 * still open at the cap is never buffered further. `overflow` runs and the
 * lines end, which ends the channel.
 */
export async function* boundedLines(
  input: AsyncIterable<Uint8Array | string>,
  max: number,
  overflow: () => void,
): AsyncGenerator<string> {
  let held: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    let rest = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    for (;;) {
      const newline = rest.indexOf(0x0a);
      const part = newline < 0 ? rest : rest.subarray(0, newline);
      if (size + part.length + (newline < 0 ? 0 : 1) > max) {
        overflow();
        return;
      }
      if (newline < 0) {
        if (part.length > 0) {
          held.push(part);
          size += part.length;
        }
        break;
      }
      yield Buffer.concat([...held, part]).toString("utf8");
      held = [];
      size = 0;
      rest = rest.subarray(newline + 1);
    }
  }
  if (size > 0) yield Buffer.concat(held).toString("utf8");
}

const stdinLines = (): AsyncIterable<string> =>
  boundedLines(process.stdin, COMPANION_MAX_INBOUND_BYTES, () => {
    process.stdout.write(companionConnectionErrorLine("too-large", COMPANION_ERROR_COPY["too-large"]));
  });

export const runCompanionStdio = async (args: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseCompanionStdioArgs(args);
  if (!parsed.ok) {
    // Still one protocol frame on stdout, so a phone sees a reason; usage on stderr.
    process.stdout.write(companionConnectionErrorLine("invalid", "This key is not set up for Junto."));
    process.stderr.write(`junto companion-stdio: ${parsed.message}\n`);
    process.exitCode = 64;
    return;
  }
  const host = parsed.mode === "demo"
    ? makeDemoHost({ machineName: defaultMachineName(), portraitPng: rasterizePortraitSvg })
    : makeRelayHost(parsed.deviceId, operatorCall, wakeInstalledApp);
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
