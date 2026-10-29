/**
 * Running an automation's code step on the automation's machine (plan
 * 0.11/05, Code steps, track K2). automation-lead's K1 owns the step, its
 * input and what the result does to the firing; this module owns the rest of
 * the seam: the source fetched and verified, the process, the SDK, the
 * timeout, the bounds and the scrub.
 *
 * - **One runtime.** TypeScript runs on this machine's own `junto` binary as
 *   bun (`BUN_BE_BUN=1`): the app ships it at `<resources>/bin/junto`, a
 *   windowless core at `bin/junto`, so there is no Electron and nothing else
 *   to install (docs/machines.md Rules 1 and 10). Shell is `/bin/sh <file>`.
 * - **Admission** (docs/security-doctrine.md, Code steps): the copy run
 *   verifies against the ref's digest. The other checks (an applied ruling,
 *   its author, the automation naming this machine) belong to the automation
 *   domain, before it calls here; there is no per-machine allowance.
 * - **Input is data.** The input is JSON on stdin; the source is copied into
 *   a 0700 directory made for the run, verified there, run there with that
 *   directory as its working directory, and removed after it. Neither is ever
 *   in argv or a shell string.
 * - **Folders change nothing.** TypeScript imports resolve only to the SDK
 *   and the runtime's built-ins (`code-sdk.ts`, the launcher); no `.env`,
 *   `bunfig.toml`, `package.json` or `tsconfig.json` of any folder is read
 *   and nothing is installed: the run directory holds its own empty ones and
 *   bun runs with `--no-install --no-env-file`.
 * - **Answer.** One JSON line on fd 3, bounded by `maxOutputBytes`; the first
 *   line wins. With none, exit 0 continues with no output, anything else fails.
 * - **Environment.** A fixed base (PATH, HOME, TMPDIR, LANG) and the region's
 *   values, never the core's own: no Junto socket or token reaches the code,
 *   and `JUNTO_WORK_TOKEN` is empty so the CLI refuses owner commands to it.
 *   The child holds no Junto credential: the SDK has no Junto operations.
 * - **Secrets.** The region's values never reach a log or a value: the log
 *   tail is scrubbed, and an output that carries one fails the step.
 *
 * The child runs as this OS account. It is not a sandbox.
 */
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { ContentRef } from "@shared/content";
import { WORK_TOKEN_ENV } from "@shared/work-control";
import {
  knownSecretValues,
  launchSecretValues,
  registerKnownSecrets,
  releaseKnownSecrets,
  scrubMessage,
  StderrTail,
  type ScrubbedTail,
} from "../credentials/scrub";
import { appProcessPlane, type AppProcessExit, type AppProcessLease } from "../app-process-plane";
import type { ContentServiceShape } from "../content/service";
import { juntoCliPathPrefixes } from "../term/templates/seat-env";
import { CODE_LAUNCHER_SOURCE, CODE_SDK_SOURCE } from "./code-sdk";
import type { CodeArtifact } from "./code-step";

export type CodeLanguage = "typescript" | "shell";

/** What the code reads on stdin and through the SDK (K1's input). */
export type CodeInput = {
  readonly automation: { readonly automationId: string; readonly name: string; readonly nodeId: string };
  readonly firing: { readonly firingId: string; readonly at: number; readonly cause: string };
  readonly trigger: unknown;
  readonly event: unknown;
  readonly values: Readonly<Record<string, string>>;
  /** Under an artifact trigger, the artifact that fired it (B1). */
  readonly artifact?: CodeArtifact;
};

export type CodeRunRequest = {
  readonly canvasName: string;
  readonly source: ContentRef;
  readonly language: CodeLanguage;
  readonly input: CodeInput;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** The region environment on this machine, names to values. */
  readonly env: Readonly<Record<string, string>>;
};

export type CodeOutputValue = string | number | boolean;

/** What one run answered. `logTail` is the last lines of stdout and stderr, scrubbed, for the firing log only. */
export type CodeResult =
  | { readonly kind: "continue"; readonly output: Readonly<Record<string, CodeOutputValue>>; readonly durationMs: number; readonly logTail?: ScrubbedTail }
  | { readonly kind: "stop"; readonly reason?: string; readonly durationMs: number; readonly logTail?: ScrubbedTail }
  | { readonly kind: "fail"; readonly message: string; readonly exitCode?: number; readonly durationMs: number; readonly logTail?: ScrubbedTail }
  | { readonly kind: "timeout"; readonly durationMs: number; readonly logTail?: ScrubbedTail }
  | { readonly kind: "too_large"; readonly durationMs: number; readonly logTail?: ScrubbedTail };

/** A failed admission check: the firing log names the check and the machine. */
export class CodeNotPermitted extends Schema.TaggedError<CodeNotPermitted>()("CodeNotPermitted", {
  check: Schema.Literal("digest"),
  machine: Schema.String,
  canvasName: Schema.String,
  message: Schema.String,
}) {}

/** The source is not held here, or could not be read. */
export class CodeSourceUnavailable extends Schema.TaggedError<CodeSourceUnavailable>()("CodeSourceUnavailable", {
  machine: Schema.String,
  state: Schema.String,
  message: Schema.String,
}) {}

/** This machine has no `junto` binary to run TypeScript on. */
export class CodeRuntimeMissing extends Schema.TaggedError<CodeRuntimeMissing>()("CodeRuntimeMissing", {
  machine: Schema.String,
  message: Schema.String,
}) {}

/** The process could not be started, or its run directory made. */
export class CodeSpawnFailed extends Schema.TaggedError<CodeSpawnFailed>()("CodeSpawnFailed", {
  machine: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export type CodeRunError = CodeNotPermitted | CodeSourceUnavailable | CodeRuntimeMissing | CodeSpawnFailed;

/** K1's bounds, checked here too: the seam never trusts its caller's numbers. */
export const CODE_TIMEOUT_MIN_MS = 1_000;
export const CODE_TIMEOUT_MAX_MS = 900_000;
export const CODE_MAX_OUTPUT_BYTES = 65_536;
/** A step's source; code that needs more belongs in a package on the machine. */
export const CODE_SOURCE_MAX_BYTES = 1024 * 1024;
export const CODE_OUTPUT_FIELD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const CODE_OUTPUT_VALUE_MAX_CHARS = 8_000;
export const CODE_OUTPUT_MAX_FIELDS = 64;
/** After TERM at the timeout, the group has this long before KILL. */
export const CODE_KILL_GRACE_MS = 2_000;
/** After the child exits, its pipes have this long to drain before the run settles. */
const DRAIN_MS = 1_000;

/** The child's environment starts from these names of this process's, and nothing else of it. */
export const CODE_BASE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

const OutputValue = Schema.Union([
  Schema.String.pipe(Schema.check(Schema.isMaxLength(CODE_OUTPUT_VALUE_MAX_CHARS))),
  Schema.Finite,
  Schema.Boolean,
]);
const Message = Schema.String.pipe(Schema.check(Schema.isMaxLength(CODE_OUTPUT_VALUE_MAX_CHARS)));

/** The one line the SDK, or a shell step's `printf ... >&3`, writes. */
const CodeAnswer = Schema.Union([
  // Names are checked after the decode: a refined record key filters rather than refuses.
  Schema.Struct({ kind: Schema.Literal("continue"), output: Schema.optionalKey(Schema.Record(Schema.String, OutputValue)) }),
  Schema.Struct({ kind: Schema.Literal("stop"), reason: Schema.optionalKey(Message) }),
  Schema.Struct({ kind: Schema.Literal("fail"), message: Message }),
]);
type CodeAnswer = typeof CodeAnswer.Type;
const decodeAnswer = Schema.decodeUnknownSync(CodeAnswer, { onExcessProperty: "error" });

export type CodeRunnerDeps = {
  /** This machine's name, for refusals. */
  readonly machine: string;
  /** The source's bytes, or why they are not held here. */
  readonly readSource: (ref: ContentRef) => Effect.Effect<Uint8Array | { readonly state: string }, unknown>;
  /** The `junto` binary TypeScript runs on; undefined when this machine has none. */
  readonly runtime?: () => string | undefined;
  /** This process's environment, for the base names only. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly shell?: string;
  /** Where run directories are made; the system temp directory by default. */
  readonly runRoot?: string;
};

/** The `junto` binary this machine ships its seats, or undefined. */
export const machineJuntoBinary = (): string | undefined => {
  const dir = juntoCliPathPrefixes()[0];
  return dir === undefined ? undefined : join(dir, "junto");
};

/** A source read from this machine's content store: verified present, read whole, bounded. */
export const contentSourceReader = (content: Pick<ContentServiceShape, "openForRead">) =>
  (ref: ContentRef): Effect.Effect<Uint8Array | { readonly state: string }, unknown> => {
    if (ref.byteLength > CODE_SOURCE_MAX_BYTES) return Effect.succeed({ state: "too_large" });
    return content.openForRead(ref).pipe(
      Effect.catch(() => Effect.succeed({ state: "unavailable" } as const)),
      Effect.flatMap((opened): Effect.Effect<Uint8Array | { readonly state: string }, unknown> => opened.state === "verified"
        ? Effect.tryPromise(() => readFile(opened.path))
        : Effect.succeed({ state: opened.state })),
    );
  };

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The base names from this process, then the region's values, then what the runner itself sets. */
export const codeEnvironment = (
  language: CodeLanguage,
  region: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of CODE_BASE_ENV_NAMES) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(region)) {
    if (name === "__proto__") continue;
    env[name] = value;
  }
  // Defined and empty: the CLI refuses owner and machine commands (src/cli/core/owner-access.ts).
  env[WORK_TOKEN_ENV] = "";
  if (language === "typescript") env.BUN_BE_BUN = "1";
  else delete env.BUN_BE_BUN;
  return env;
};

/** The region values an output may not carry and a log may not show. */
const regionSecretValues = (region: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  launchSecretValues([], region).filter((value): value is string => value !== undefined);

const outputCarriesSecret = (output: Readonly<Record<string, CodeOutputValue>>, secrets: ReadonlyArray<string>): boolean =>
  Object.values(output).some(value => typeof value === "string" && secrets.some(secret => value.includes(secret)));

type ProcessEnd = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly answer: Buffer;
  readonly timedOut: boolean;
  readonly tooLarge: boolean;
  readonly durationMs: number;
  readonly tail: StderrTail;
};

type ProcessPlan = {
  readonly shell: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: string;
  readonly answerFile: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

/**
 * The fixed launcher the plane's group leader runs: fd 3 opens on the run's
 * answer file, the step runs in the foreground, and when it ends what it
 * started is sent TERM; the step's own end is kept (a signal re-raised).
 * Every path and argument arrives as "$@", never in this string.
 */
const CODE_GROUP_LAUNCHER = [
  'answer=$1; shift',
  'exec 3>"$answer" || exit 125',
  "trap : TERM",
  '"$@"',
  "status=$?",
  "kill -TERM 0 2>/dev/null",
  'if [ "$status" -gt 128 ]; then trap - TERM; kill -"$((status - 128))" $$; fi',
  'exit "$status"',
].join("\n");

/** How often a running step's answer file is measured against its bound. */
const ANSWER_POLL_MS = 100;

/**
 * One step as a process group of the central process plane (docs/security-doctrine.md):
 * the timeout sends the group TERM then KILL, quit drains it, and what the
 * step leaves past TERM the plane signals at quit.
 */
const runProcess = (plan: ProcessPlan, abort: AbortSignal): Promise<ProcessEnd> =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const tail = new StderrTail();
    let timedOut = false;
    let tooLarge = false;
    let exited: AppProcessExit | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    let lease: AppProcessLease;
    try {
      lease = appProcessPlane.spawnGroup({
        source: "automation.code",
        purpose: "automation code step",
        command: plan.shell,
        args: ["-c", CODE_GROUP_LAUNCHER, "junto-code", plan.answerFile, plan.command, ...plan.args],
        cwd: plan.cwd,
        env: plan.env,
      });
    } catch (cause) {
      reject(cause);
      return;
    }
    const io = lease.io;
    const kill = (reason: string): void => void appProcessPlane.forceTerminate(lease, reason);

    const settle = (): void => {
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      clearInterval(measure);
      abort.removeEventListener("abort", onAbort);
      offError();
    };
    const finish = (): void => {
      if (settled || exited === undefined) return;
      const end = exited;
      settle();
      void readAnswer(plan.answerFile, plan.maxOutputBytes).then((read) => resolve({
        exitCode: end.code,
        signal: end.signal,
        answer: read.answer,
        timedOut,
        tooLarge: tooLarge || read.tooLarge,
        durationMs: Math.round(performance.now() - started),
        tail,
      }), reject);
    };
    const onAbort = (): void => kill("automation code step aborted");
    abort.addEventListener("abort", onAbort, { once: true });

    const offError = io.onError((cause) => {
      if (settled) return;
      settle();
      kill("automation code step process error");
      reject(cause);
    });

    // The answer is bounded while the step runs, not only after: a runaway writer is ended.
    const measure = setInterval(() => {
      void stat(plan.answerFile).then((file) => {
        if (tooLarge || exited !== undefined || file.size <= plan.maxOutputBytes) return;
        tooLarge = true;
        kill("automation code step answer past its bound");
      }, () => undefined);
    }, ANSWER_POLL_MS);

    io.stdout.on("data", (chunk: Buffer) => tail.push(chunk));
    io.stderr.on("data", (chunk: Buffer) => tail.push(chunk));

    // Code that never reads its input closes stdin early: that is not a failure.
    io.stdin.on("error", () => undefined);
    io.stdin.end(plan.stdin);

    timers.push(setTimeout(() => {
      timedOut = true;
      appProcessPlane.terminate(lease, "automation code step timeout");
      timers.push(setTimeout(() => kill("automation code step timeout"), CODE_KILL_GRACE_MS));
    }, plan.timeoutMs));

    void io.exited.then((event) => {
      exited = event;
      timers.push(setTimeout(finish, DRAIN_MS));
    });
    void io.closed.then(() => finish());
  });

/** The answer file as the step left it: at most one byte past the bound is read. */
const readAnswer = async (file: string, maxOutputBytes: number): Promise<{ readonly answer: Buffer; readonly tooLarge: boolean }> => {
  const handle = await open(file, "r").catch(() => undefined);
  if (handle === undefined) return { answer: Buffer.alloc(0), tooLarge: false };
  try {
    const buffer = Buffer.alloc(maxOutputBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxOutputBytes
      ? { answer: Buffer.alloc(0), tooLarge: true }
      : { answer: buffer.subarray(0, bytesRead), tooLarge: false };
  } finally {
    await handle.close();
  }
};

/**
 * The run's own directory: the source copied in, and for TypeScript the
 * launcher, the SDK and empty config files of its own, so no folder's are read.
 */
const prepareRunDirectory = async (dir: string, language: CodeLanguage, source: Uint8Array): Promise<string> => {
  if (language === "shell") {
    const file = join(dir, "step.sh");
    await writeFile(file, source, { mode: 0o600 });
    return file;
  }
  await writeFile(join(dir, "step.ts"), source, { mode: 0o600 });
  await writeFile(join(dir, "sdk.ts"), CODE_SDK_SOURCE, { mode: 0o600 });
  await writeFile(join(dir, "bunfig.toml"), "", { mode: 0o600 });
  await writeFile(join(dir, "tsconfig.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, { mode: 0o600 });
  const launcher = join(dir, "launch.ts");
  await writeFile(launcher, CODE_LAUNCHER_SOURCE, { mode: 0o600 });
  return launcher;
};

/** What the copy in the run directory reads as, checked against the ref. */
const verifiedCopy = async (file: string, ref: ContentRef): Promise<boolean> => {
  const copy = await readFile(file);
  return copy.byteLength === ref.byteLength && sha256Hex(copy) === ref.sha256;
};

const exitWords = (end: ProcessEnd): string =>
  end.signal !== null ? `The step ended on ${end.signal}` : `The step exited with code ${end.exitCode ?? "unknown"}`;

/** What one process end answers, with every text a person or a log reads scrubbed. */
export const codeResultOf = (end: ProcessEnd, secrets: ReadonlyArray<string>): CodeResult => {
  const known = knownSecretValues(secrets);
  const logTail = end.tail.read(known);
  const durationMs = end.durationMs;
  const withTail = logTail.text.length > 0 ? { logTail } : {};
  if (end.tooLarge) return { kind: "too_large", durationMs, ...withTail };
  if (end.timedOut) return { kind: "timeout", durationMs, ...withTail };
  const exitCode = end.exitCode ?? undefined;
  const text = end.answer.toString("utf8");
  const newline = text.indexOf("\n");
  const line = (newline < 0 ? text : text.slice(0, newline)).trim();
  if (line.length === 0) {
    return end.exitCode === 0 && end.signal === null
      ? { kind: "continue", output: {}, durationMs, ...withTail }
      : { kind: "fail", message: exitWords(end), ...(exitCode === undefined ? {} : { exitCode }), durationMs, ...withTail };
  }
  let answer: CodeAnswer;
  try {
    answer = decodeAnswer(JSON.parse(line));
  } catch {
    return {
      kind: "fail",
      message: "The step's result line is not a result: continue with output fields named [a-z][a-z0-9_]* holding text up to 8000 characters, a number or a boolean; stop; or fail with a message",
      ...(exitCode === undefined ? {} : { exitCode }),
      durationMs,
      ...withTail,
    };
  }
  switch (answer.kind) {
    case "continue": {
      const output = answer.output ?? {};
      const badName = Object.keys(output).find(name => !CODE_OUTPUT_FIELD_PATTERN.test(name));
      if (badName !== undefined) {
        return { kind: "fail", message: `The step's output field ${scrubMessage(badName.slice(0, 64), known)} is not named [a-z][a-z0-9_]*`, durationMs, ...withTail };
      }
      if (Object.keys(output).length > CODE_OUTPUT_MAX_FIELDS) {
        return { kind: "fail", message: `The step's output has more than ${CODE_OUTPUT_MAX_FIELDS} fields`, durationMs, ...withTail };
      }
      if (outputCarriesSecret(output, secrets)) return { kind: "fail", message: "output_carries_secret", durationMs, ...withTail };
      return { kind: "continue", output, durationMs, ...withTail };
    }
    case "stop":
      return answer.reason === undefined
        ? { kind: "stop", durationMs, ...withTail }
        : { kind: "stop", reason: scrubMessage(answer.reason, known), durationMs, ...withTail };
    case "fail":
      return { kind: "fail", message: scrubMessage(answer.message, known) || "The step failed", ...(exitCode === undefined ? {} : { exitCode }), durationMs, ...withTail };
  }
};

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;

/** The K1 port: run one code step on this machine. */
export const makeCodeRunner = (deps: CodeRunnerDeps) => {
  const runtime = deps.runtime ?? machineJuntoBinary;
  const baseEnv = deps.baseEnv ?? process.env;
  const shell = deps.shell ?? "/bin/sh";
  const runRoot = deps.runRoot ?? tmpdir();

  const runCode = (request: CodeRunRequest): Effect.Effect<CodeResult, CodeRunError> => Effect.gen(function* () {
    const read = yield* deps.readSource(request.source).pipe(
      Effect.mapError((cause) => new CodeSourceUnavailable({ machine: deps.machine, state: "unreadable", message: scrubMessage(String(cause)) })),
    );
    if (!(read instanceof Uint8Array)) {
      return yield* new CodeSourceUnavailable({
        machine: deps.machine,
        state: read.state,
        message: `The step's code is ${read.state} on ${deps.machine}`,
      });
    }

    let command: string;
    if (request.language === "typescript") {
      const binary = runtime();
      if (binary === undefined) {
        return yield* new CodeRuntimeMissing({ machine: deps.machine, message: `${deps.machine} has no junto binary to run TypeScript on` });
      }
      command = binary;
    } else {
      command = shell;
    }

    const env = codeEnvironment(request.language, request.env, baseEnv);
    // The child's whole environment is known to the scrub; the shown names (PATH, HOME) stay readable.
    const secrets = regionSecretValues(env);
    const owner = `code:${request.input.firing.firingId}`;
    const timeoutMs = clamp(request.timeoutMs, CODE_TIMEOUT_MIN_MS, CODE_TIMEOUT_MAX_MS);
    const maxOutputBytes = clamp(request.maxOutputBytes, 1, CODE_MAX_OUTPUT_BYTES);
    const spawnFailed = (message: string) => (cause: unknown) =>
      new CodeSpawnFailed({ machine: deps.machine, message, cause: scrubMessage(String(cause), knownSecretValues(secrets)) });

    const end = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          registerKnownSecrets(owner, secrets);
          return mkdtemp(join(runRoot, "junto-code-"));
        },
        catch: spawnFailed("The step's run directory could not be made"),
      }),
      (dir) => Effect.tryPromise({
        try: async (signal): Promise<ProcessEnd | "digest"> => {
          const file = await prepareRunDirectory(dir, request.language, read);
          if (!await verifiedCopy(join(dir, request.language === "shell" ? "step.sh" : "step.ts"), request.source)) return "digest";
          const args = request.language === "typescript"
            ? ["run", "--no-install", "--no-env-file", `--config=${join(dir, "bunfig.toml")}`, `--tsconfig-override=${join(dir, "tsconfig.json")}`, file]
            : [file];
          const answerFile = join(dir, "answer");
          await writeFile(answerFile, "", { mode: 0o600 });
          return runProcess({
            shell,
            command,
            args,
            cwd: dir,
            env,
            stdin: JSON.stringify(request.input),
            answerFile,
            timeoutMs,
            maxOutputBytes,
          }, signal);
        },
        catch: spawnFailed("The step could not be started"),
      }),
      (dir) => Effect.promise(async () => {
        releaseKnownSecrets(owner);
        await rm(dir, { recursive: true, force: true });
      }),
    );
    if (end === "digest") {
      return yield* new CodeNotPermitted({
        check: "digest",
        machine: deps.machine,
        canvasName: request.canvasName,
        message: `The step's code on ${deps.machine} does not match the digest its automation names`,
      });
    }

    const result = codeResultOf(end, secrets);
    yield* Effect.logInfo("automation code step ran").pipe(Effect.annotateLogs({
      area: "automation",
      automationId: request.input.automation.automationId,
      firingId: request.input.firing.firingId,
      language: request.language,
      digest: request.source.sha256,
      result: result.kind,
      durationMs: result.durationMs,
      ...(end.exitCode === null ? {} : { exitCode: end.exitCode }),
    }));
    return result;
  });

  return { runCode };
};

export type CodeRunner = ReturnType<typeof makeCodeRunner>;
