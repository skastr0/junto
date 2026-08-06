#!/usr/bin/env bun
/**
 * Live acceptance for the work control plane + compiled `dist/vellum-command`.
 *
 * Boots the real NDJSON work control daemon (WorkService + CanvasesService)
 * against a sandboxed work home, then drives the compiled CLI from a cwd
 * outside the repo. Proves doctor/onboard/capabilities/claim/batch/scope/
 * artifact/request + 0600 token + wrong-token AuthError without fighting
 * Electron's single-instance lock.
 *
 *   bun run cli:build && bun scripts/work-cli-acceptance.ts
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  createAppProcessPlane,
  type AppProcessDrainResult,
  type AppProcessPlane,
} from "../src/main/vellum/app-process-plane";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import {
  startWorkControlServer,
  type WorkControlShutdownReceipt,
} from "../src/main/vellum/work/control";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { PausePlaneAllPlaying } from "../src/main/vellum/pause-plane";
import { makeProcessIdentityMap } from "../src/main/vellum/process-identity";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import { WORK_MAX_FRAME_BYTES } from "../src/shared/work-control";
import { IntentFactBasis } from "../src/shared/work-protocol";

const REPO = process.cwd();
const CLI = join(REPO, "dist/vellum-command");
const CANVAS = "work-acc";
const AGENT = "agent";
const TASKS = "tasks";
const REQS = "req";
const ARTS = "art";
const CLI_TIMEOUT_MS = 10_000;
const CLI_OUTPUT_LIMIT_BYTES = 256 * 1024;
const CLI_TERM_GRACE_MS = 250;
const CLI_KILL_CLOSE_GRACE_MS = 1_500;
const SOCKET_TIMEOUT_MS = 5_000;

export type WorkCliCommandFailureKind =
  | "timeout"
  | "stdout-overflow"
  | "stderr-overflow"
  | "stdio-error"
  | "spawn-error"
  | "close-timeout";

export class WorkCliCommandFailure extends Error {
  readonly kind: WorkCliCommandFailureKind;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    kind: WorkCliCommandFailureKind,
    message: string,
    stdout: string,
    stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkCliCommandFailure";
    this.kind = kind;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface BoundedWorkCliCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Per stream. The retained stdout and stderr can never exceed this bound. */
  readonly outputLimitBytes?: number;
  readonly termGraceMs?: number;
  readonly killCloseGraceMs?: number;
}

export interface WorkCliCommandResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface BoundedBytes {
  readonly append: (chunk: Buffer | string) => boolean;
  readonly text: () => string;
}

const boundedSetting = (
  value: number | undefined,
  maximum: number,
  label: string,
): number => {
  const configured = value ?? maximum;
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${String(maximum)}`);
  }
  return configured;
};

const boundedBytes = (limitBytes: number): BoundedBytes => {
  const parts: Buffer[] = [];
  let retainedBytes = 0;
  let overflowed = false;
  return {
    append: (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = Math.max(0, limitBytes - retainedBytes);
      if (available > 0) {
        const retained = bytes.byteLength <= available ? bytes : bytes.subarray(0, available);
        parts.push(Buffer.from(retained));
        retainedBytes += retained.byteLength;
      }
      if (bytes.byteLength > available) overflowed = true;
      return overflowed;
    },
    text: () => Buffer.concat(parts, retainedBytes).toString("utf8"),
  };
};

/**
 * Run one exact CLI child under an isolated central process authority.
 *
 * A deadline or output overflow closes the admission locally, requests TERM,
 * then escalates to KILL through the same opaque lease. The promise normally
 * settles only after the child's `close` witness. If even KILL cannot produce
 * that witness inside the bounded close grace, the lease stays registered so
 * the caller's mandatory process-plane drain reports an unclean straggler.
 */
export const runBoundedWorkCliCommand = (
  processPlane: AppProcessPlane,
  spec: BoundedWorkCliCommand,
): Promise<WorkCliCommandResult> => {
  const timeoutMs = boundedSetting(spec.timeoutMs, CLI_TIMEOUT_MS, "CLI timeout");
  const outputLimitBytes = boundedSetting(
    spec.outputLimitBytes,
    CLI_OUTPUT_LIMIT_BYTES,
    "CLI output limit",
  );
  const termGraceMs = boundedSetting(
    spec.termGraceMs,
    CLI_TERM_GRACE_MS,
    "CLI TERM grace",
  );
  const killCloseGraceMs = boundedSetting(
    spec.killCloseGraceMs,
    CLI_KILL_CLOSE_GRACE_MS,
    "CLI KILL close grace",
  );
  const lease = processPlane.spawnChild({
    source: "work-cli-acceptance",
    purpose: `run ${spec.args[0] ?? "command"}`,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
  });
  const stdout = boundedBytes(outputLimitBytes);
  const stderr = boundedBytes(outputLimitBytes);
  let fault: { readonly kind: WorkCliCommandFailureKind; readonly message: string } | undefined;
  let childError: Error | undefined;
  let escalationTimer: NodeJS.Timeout | undefined;
  let closeDeadlineTimer: NodeJS.Timeout | undefined;
  let rejectCloseDeadline!: (error: WorkCliCommandFailure) => void;
  const closeDeadline = new Promise<never>((_resolve, reject) => {
    rejectCloseDeadline = reject;
  });

  const faultOnce = (kind: WorkCliCommandFailureKind, message: string): void => {
    if (fault !== undefined) return;
    fault = { kind, message };
    processPlane.terminate(lease, `work-cli-${kind}`);
    escalationTimer = setTimeout(() => {
      processPlane.forceTerminate(lease, `work-cli-${kind}-term-timeout`);
    }, termGraceMs);
    closeDeadlineTimer = setTimeout(() => {
      clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      removeErrorListener();
      rejectCloseDeadline(
        new WorkCliCommandFailure(
          "close-timeout",
          `${message}; exact child close was not observed after TERM and KILL`,
          stdout.text(),
          stderr.text(),
          childError === undefined ? undefined : { cause: childError },
        ),
      );
    }, termGraceMs + killCloseGraceMs);
  };

  const onStdout = (chunk: Buffer | string): void => {
    if (stdout.append(chunk)) {
      faultOnce(
        "stdout-overflow",
        `work CLI stdout exceeded ${String(outputLimitBytes)} bytes`,
      );
    }
  };
  const onStderr = (chunk: Buffer | string): void => {
    if (stderr.append(chunk)) {
      faultOnce(
        "stderr-overflow",
        `work CLI stderr exceeded ${String(outputLimitBytes)} bytes`,
      );
    }
  };
  const onStdioError = (stream: "stdin" | "stdout" | "stderr", error: Error): void => {
    childError ??= error;
    faultOnce("stdio-error", `work CLI ${stream} reported an error: ${error.message}`);
  };
  const onStdinError = (error: Error): void => onStdioError("stdin", error);
  const onStdoutError = (error: Error): void => onStdioError("stdout", error);
  const onStderrError = (error: Error): void => onStdioError("stderr", error);
  lease.io.stdout.on("data", onStdout);
  lease.io.stderr.on("data", onStderr);
  lease.io.stdin.on("error", onStdinError);
  lease.io.stdout.on("error", onStdoutError);
  lease.io.stderr.on("error", onStderrError);
  const removeErrorListener = lease.io.onError((error) => {
    childError ??= error;
    faultOnce("spawn-error", `work CLI child reported an error: ${error.message}`);
  });
  try {
    lease.io.stdin.end();
  } catch (error) {
    onStdinError(error instanceof Error ? error : new Error(String(error)));
  }

  const timeoutTimer = setTimeout(() => {
    faultOnce("timeout", `work CLI exceeded its ${String(timeoutMs)}ms deadline`);
  }, timeoutMs);

  const closed = lease.io.closed.then(({ code, signal }) => {
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    if (closeDeadlineTimer !== undefined) clearTimeout(closeDeadlineTimer);
    clearTimeout(timeoutTimer);
    lease.io.stdout.off("data", onStdout);
    lease.io.stderr.off("data", onStderr);
    lease.io.stdin.off("error", onStdinError);
    lease.io.stdout.off("error", onStdoutError);
    lease.io.stderr.off("error", onStderrError);
    removeErrorListener();
    const stdoutText = stdout.text();
    const stderrText = stderr.text();
    if (fault !== undefined) {
      throw new WorkCliCommandFailure(
        fault.kind,
        fault.message,
        stdoutText,
        stderrText,
        childError === undefined ? undefined : { cause: childError },
      );
    }
    return {
      code: code ?? 1,
      signal,
      stdout: stdoutText,
      stderr: stderrText,
    };
  });

  return Promise.race([closed, closeDeadline]);
};

const seed = (): import("../src/shared/canvas").CanvasDoc =>
  ({
  nodes: [
    {
      id: AGENT,
      type: "text" as const,
      x: 40,
      y: 40,
      width: 140,
      height: 56,
      text: "agent",
      ether: {
        entity: { kind: "agent", name: "local:default" },
        terminal: {
          bindingId: "work-acceptance-agent",
          harness: "claude",
        },
      },
    },
    {
      id: TASKS,
      type: "text" as const,
      x: 240,
      y: 40,
      width: 160,
      height: 80,
      text: "ship it",
      ether: {
        entity: { kind: "task" as const },
      },
    },
    {
      id: REQS,
      type: "text" as const,
      x: 440,
      y: 40,
      width: 160,
      height: 80,
      text: "0 pending",
      ether: { entity: { kind: "requests" as const } },
    },
    {
      id: ARTS,
      type: "text" as const,
      x: 640,
      y: 40,
      width: 160,
      height: 80,
      text: "artifacts",
      ether: { entity: { kind: "artifacts" as const } },
    },
    {
      id: "region",
      type: "group" as const,
      x: 0,
      y: 0,
      width: 900,
      height: 200,
      label: "Acceptance",
      ether: { region: { hold: false, instruction: "accept the work plane" } },
    },
  ],
  edges: [
    { id: "e-tasks", fromNode: AGENT, toNode: TASKS },
    { id: "e-req", fromNode: AGENT, toNode: REQS },
    { id: "e-art", fromNode: AGENT, toNode: ARTS },
  ],
} as import("../src/shared/canvas").CanvasDoc);

const runCli = (
  processPlane: AppProcessPlane,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<WorkCliCommandResult> =>
  runBoundedWorkCliCommand(processPlane, {
    command: CLI,
    args,
    env,
    cwd,
  });

const readWrongTokenReceipt = async (
  socketPath: string,
): Promise<string> => {
  const socket = createConnection({ path: socketPath });
  const closed = new Promise<void>((resolveClosed) => {
    socket.once("close", () => resolveClosed());
  });
  let frame = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolveReceipt, rejectReceipt) => {
      timer = setTimeout(() => {
        rejectReceipt(new Error("wrong-token work control probe timed out"));
      }, SOCKET_TIMEOUT_MS);
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({
            token: "0".repeat(64),
            op: "ping",
          })}\n`,
        );
      });
      socket.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (frame.byteLength + part.byteLength > WORK_MAX_FRAME_BYTES) {
          rejectReceipt(new Error("wrong-token work control response exceeded its frame bound"));
          return;
        }
        frame = Buffer.concat([frame, part]);
        const newline = frame.indexOf(0x0a);
        if (newline < 0) return;
        resolveReceipt(frame.subarray(0, newline).toString("utf8"));
      });
      socket.once("error", rejectReceipt);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    socket.destroy();
    await closed;
  }
};

const log = (label: string, body: string) => {
  process.stdout.write(`\n### ${label}\n${body.trim()}\n`);
};

const main = async () => {
  if (!existsSync(CLI)) {
    throw new Error("missing dist/vellum-command — run bun run cli:build");
  }

  const root = await mkdtemp(join(tmpdir(), "vellum-command-work-acc-"));
  const canvases = join(root, "canvases");
  const workHome = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(canvases, { recursive: true });
  mkdirSync(workHome, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const artifactPath = join(outside, "report.txt");
  writeFileSync(artifactPath, "acceptance artifact body\n");

  const previousCanvasesDir = process.env.VELLUM_COMMAND_CANVASES_DIR;
  const previousWorkHome = process.env.VELLUM_COMMAND_WORK_HOME;
  process.env.VELLUM_COMMAND_CANVASES_DIR = canvases;
  process.env.VELLUM_COMMAND_WORK_HOME = workHome;

  const processPlane = createAppProcessPlane({
    termGraceMs: CLI_TERM_GRACE_MS,
    killGraceMs: CLI_KILL_CLOSE_GRACE_MS,
  });
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
    ),
    makeStateEngineLive(join(root, "state", "vellum-command.db")),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
  );
  const runtime = ManagedRuntime.make((
    Layer.mergeAll(workLive, PausePlaneAllPlaying) as never),
  );
  // Establish the same canonical role and topology services used in the app.
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(
    settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    }),
  );

  // Author only topology, then seed fixed acceptance work through explicit
  // WorkRepository verbs. The canvas never carries a durable work projection.
  const canvasesSvc = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvasesSvc.write(CANVAS, seed()));
  const intentWitness = await runtime.runPromise(
    canvasesSvc.activeIntentWitness(),
  );
  const basis = Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind: "authorial-intent",
    generation: intentWitness.generation,
    contentSha256: intentWitness.contentSha256,
  });
  const repository = await runtime.runPromise(WorkRepository);
  for (const [id, messageId, brief] of [
    ["t1", "m0", "ship it"],
    ["t2", "m1", "also this"],
  ] as const) {
    await runtime.runPromise(
      repository.createTask({
        sink: { canvasName: CANVAS, nodeId: TASKS },
        basis,
        task: {
          id,
          state: "submitted",
          history: [
            {
              messageId,
              role: "user",
              parts: [{ kind: "text", text: brief }],
              contextId: CANVAS,
              taskId: id,
            },
          ],
        },
      }),
    );
  }
  // Bind the acceptance runner PID. CLI children walk PPID to this process.
  const processMap = makeProcessIdentityMap();
  processMap.bind(process.pid, { agentKey: "local:default" });

  let server: Awaited<ReturnType<typeof startWorkControlServer>> | undefined;
  let primaryFailed = false;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    server = await startWorkControlServer({
      version: "acceptance",
      workHome,
      home: root,
      processMap,
      run: (effect) => runtime.runPromise(effect),
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VELLUM_COMMAND_WORK_HOME: workHome,
      // Identity is process-bind — no VELLUM_COMMAND_NODE_REF.
    };

    const sockMode = (await stat(server.socketPath)).mode & 0o777;
    const tokMode = (await stat(server.tokenPath)).mode & 0o777;
    log(
      "A3 perms",
      JSON.stringify({
        socket: sockMode.toString(8),
        token: tokMode.toString(8),
        socket_path: server.socketPath,
        token_path: server.tokenPath,
      }),
    );

    const doctor = await runCli(processPlane, ["doctor"], env, outside);
    log("doctor", doctor.stdout || doctor.stderr);

    const onboard = await runCli(processPlane, ["onboard"], env, outside);
    log("onboard", onboard.stdout || onboard.stderr);

    const caps = await runCli(processPlane, ["capabilities"], env, outside);
    log("capabilities", caps.stdout || caps.stderr);

    const claim = await runCli(
      processPlane,
      ["tasks", "claim", JSON.stringify({ target: TASKS, task: "t1" })],
      env,
      outside,
    );
    log("tasks claim", claim.stdout || claim.stderr);

    const batch = await runCli(
      processPlane,
      [
        "tasks",
        "update",
        JSON.stringify([
          { target: TASKS, task: "t1", state: "completed", note: "done" },
          { target: TASKS, task: "missing", state: "completed" },
        ]),
        "--concurrency",
        "2",
      ],
      env,
      outside,
    );
    log(`tasks update batch exit=${batch.code}`, batch.stdout || batch.stderr);

    const req = await runCli(
      processPlane,
      [
        "request",
        "create",
        JSON.stringify({
          target: REQS,
          brief: "approve ship?",
          metadata: { from: "acceptance" },
        }),
      ],
      env,
      outside,
    );
    log("request create", req.stdout || req.stderr);

    // Resolve request via WorkService (UI path analogue) so block would clear.
    const reqBody = JSON.parse(req.stdout || "{}");
    const createdId =
      reqBody?.data?.results?.[0]?.ok === true
        ? reqBody.data.results[0].data.id
        : undefined;
    if (createdId) {
      const resolved = await runtime.runPromise(
        Effect.gen(function* () {
          const work = yield* WorkService;
          return yield* work.workRequestResolve(
            CANVAS,
            REQS,
            createdId,
            "approved",
            "completed",
          );
        }),
      );
      log("request resolve (service)", JSON.stringify(resolved));
    }

    const art = await runCli(
      processPlane,
      [
        "artifact",
        "publish",
        JSON.stringify({
          target: ARTS,
          name: "report",
          parts: [{ kind: "raw", path: artifactPath }],
        }),
      ],
      env,
      outside,
    );
    log("artifact publish", art.stdout || art.stderr);

    const scope = await runCli(
      processPlane,
      ["tasks", "list", JSON.stringify({ target: "no-such-node" })],
      env,
      outside,
    );
    log("scope error", scope.stdout || scope.stderr);

    const wrongTok = await readWrongTokenReceipt(server.socketPath);
    log("A3 wrong token", wrongTok);

    const docAfter = (await runtime.runPromise(canvasesSvc.read(CANVAS))).doc;
    log(
      "canvas after",
      JSON.stringify(
        {
          tasks: docAfter.nodes
            .find((n: { id: string }) => n.id === TASKS)
            ?.ether?.tasks?.items?.map((t: { id: string; state: string }) => ({
              id: t.id,
              state: t.state,
            })),
          requests: docAfter.nodes
            .find((n: { id: string }) => n.id === REQS)
            ?.ether?.requests?.items?.map((t: { id: string; state: string }) => ({
              id: t.id,
              state: t.state,
            })),
          artifacts: docAfter.nodes
            .find((n: { id: string }) => n.id === ARTS)
            ?.ether?.artifacts?.items?.map((a: { name?: string; artifactId: string }) => ({
              id: a.artifactId,
              name: a.name,
            })),
        },
        null,
        2,
      ),
    );

    const claimOk = (() => {
      try {
        const j = JSON.parse(claim.stdout);
        return j.ok === true && j.data?.outcome === "succeeded";
      } catch {
        return false;
      }
    })();
    const batchOk = (() => {
      try {
        const j = JSON.parse(batch.stdout);
        return j.ok === true && j.data?.outcome === "partial_failure" && batch.code === 1;
      } catch {
        return false;
      }
    })();
    const scopeOk = (scope.stderr || scope.stdout).includes("ScopeError");
    const authOk = wrongTok.includes("AuthError");
    const artOk = (() => {
      try {
        const j = JSON.parse(art.stdout);
        return j.ok === true && j.data?.outcome === "succeeded";
      } catch {
        return false;
      }
    })();
    const doctorOk = doctor.stdout.includes("protocol_version");

    console.log("\n=== verdict ===");
    console.log(
      JSON.stringify(
        {
          doctor: doctorOk,
          claim: claimOk,
          batch_partial: batchOk,
          scope: scopeOk,
          artifact: artOk,
          auth: authOk,
          token_0600: tokMode === 0o600,
        },
        null,
        2,
      ),
    );

    if (!doctorOk || !claimOk || !batchOk || !scopeOk || !authOk || !artOk || tokMode !== 0o600) {
      throw new Error("work CLI acceptance verdict failed");
    }
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  } finally {
    // Both admission cut lines are synchronous and precede every cleanup
    // await, so neither a new CLI child nor a new control request can race the
    // snapshots below.
    try {
      server?.beginShutdown();
    } catch (error) {
      cleanupFailures.push(
        new Error("work CLI acceptance control admission gate failed", { cause: error }),
      );
    }
    try {
      processPlane.beginShutdown();
    } catch (error) {
      cleanupFailures.push(
        new Error("work CLI acceptance process admission gate failed", { cause: error }),
      );
    }
    let processDrain: AppProcessDrainResult | undefined;
    let controlDrain: WorkControlShutdownReceipt | undefined;
    const processDrainFlight = Promise.resolve().then(() => processPlane.drainOnQuit());
    const controlDrainFlight = server === undefined
      ? Promise.resolve(undefined)
      : Promise.resolve().then(() => server?.close());
    const [processOutcome, controlOutcome] = await Promise.allSettled([
      processDrainFlight,
      controlDrainFlight,
    ]);
    if (processOutcome.status === "fulfilled") {
      processDrain = processOutcome.value;
      if (!processDrain.clean) {
        cleanupFailures.push(
          new Error(
            `work CLI acceptance retained ${String(processDrain.stragglers.length)} process straggler(s)`,
          ),
        );
      }
    } else {
      cleanupFailures.push(
        new Error("work CLI acceptance process drain failed", {
          cause: processOutcome.reason,
        }),
      );
    }
    if (controlOutcome.status === "fulfilled") {
      controlDrain = controlOutcome.value;
      if (controlDrain !== undefined && !controlDrain.clean) {
        cleanupFailures.push(
          new Error(
            `work CLI acceptance retained control lifetimes: ${controlDrain.retainedLabels.join(", ") || "unknown"}`,
          ),
        );
      }
    } else {
      cleanupFailures.push(
        new Error("work CLI acceptance control server close failed", {
          cause: controlOutcome.reason,
        }),
      );
    }
    try {
      await runtime.dispose();
    } catch (error) {
      cleanupFailures.push(new Error("work CLI acceptance runtime dispose failed", { cause: error }));
    }
    if (previousCanvasesDir === undefined) delete process.env.VELLUM_COMMAND_CANVASES_DIR;
    else process.env.VELLUM_COMMAND_CANVASES_DIR = previousCanvasesDir;
    if (previousWorkHome === undefined) delete process.env.VELLUM_COMMAND_WORK_HOME;
    else process.env.VELLUM_COMMAND_WORK_HOME = previousWorkHome;
    const controlClean = server === undefined || controlDrain?.clean === true;
    if (
      cleanupFailures.length === 0 &&
      processDrain?.clean === true &&
      controlClean
    ) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(
          new Error(`work CLI acceptance sandbox cleanup failed at ${root}`, { cause: error }),
        );
      }
    } else {
      console.error(`work CLI acceptance retained its sandbox at ${root}`);
    }
  }

  if (primaryFailed || cleanupFailures.length > 0) {
    throw new AggregateError(
      primaryFailed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
      "work CLI acceptance failed",
    );
  }
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
