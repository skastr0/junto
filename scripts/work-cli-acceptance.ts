#!/usr/bin/env node
import { ModelService } from "../src/main/junto/model/service";
/**
 * Live acceptance for the work control plane + compiled `dist/junto`.
 *
 * Boots the real NDJSON work control daemon (WorkService + ModelService)
 * against a sandboxed work home, then drives the compiled CLI from a cwd
 * outside the repo, area by area (scripts/work-cli-acceptance/, run in
 * index.ts order, one file per owning seat), then the transport: the 0600
 * socket and a wrong-token AuthError. Each case is a pass, a fail, or
 * pending on the cli seat building its verb; any fail fails the run. No
 * fight with Electron's single-instance lock.
 *
 * The daemon uses node:sqlite, so run it under Node, not Bun:
 *
 *   JUNTO_FEATURE_PROFILE=all-on bun run cli:build
 *   bun build scripts/work-cli-acceptance.ts --target=node --format=cjs --packages=external --outfile=node_modules/.cache/work-cli-acceptance.cjs
 *   JUNTO_TASKS=1 JUNTO_ARTIFACTS=1 node -e 'require("./node_modules/.cache/work-cli-acceptance.cjs").runWorkCliAcceptance().catch(error => { console.error(error); process.exitCode = 1; })'
 */
import { existsSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  createAppProcessPlane,
  type AppProcessDrainResult,
  type AppProcessPlane,
} from "../src/main/junto/app-process-plane";
import { ModelLive } from "../src/main/junto/model/layer";
import { WorkModelDependentsLive } from "../src/main/junto/work/model-dependents";
import { Command } from "../src/shared/model";
import {
  startWorkControlServer,
  type WorkControlShutdownReceipt,
} from "../src/main/junto/work/control";
import {
  makeSeatCredentialRegistry,
  mintSeatCredential,
} from "../src/main/junto/work/seat-credentials";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import {
  createCanvasTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { MachineRepository, MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/junto/settings/service";
import { WORK_MAX_FRAME_BYTES, WORK_TOKEN_ENV } from "../src/shared/work-control";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { composeOverseer, type OverseerComposition } from "../src/main/junto/overseer/composition";
import { ActorSeatOccupyLive } from "../src/main/junto/term/actor-seat-occupy-live";
import { ARTIFACTS_ENABLED, TASKS_ENABLED } from "../src/shared/features";
import { ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { OpRepositoryLive } from "../src/main/junto/work/op-repository";
import { makeResourceSubmitLayer } from "../src/main/junto/work/resource-submit";
import { ResourceRulerLive } from "../src/main/junto/work/resource-ruler";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/main/junto/work/task-repository";
import type { AcceptanceContext, AcceptanceSeat, CaseVerdict } from "./work-cli-acceptance/area";
import { AREAS } from "./work-cli-acceptance/index";

const REPO = process.cwd();
const CLI = join(REPO, "dist/junto");
const CANVAS = "work-acc";
const AGENT = "agent";
const TASKS = "tasks";
const ARTS = "art";
const CLI_TIMEOUT_MS = 10_000;
/** The feature flags the CLI and the core run with: the resource verbs under test. */
const CLI_FEATURES = { JUNTO_TASKS: "1", JUNTO_ARTIFACTS: "1" } as const;
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

const seed = () => Schema.decodeUnknownSync(Command)({
  _tag: "Add", canvas: CANVAS,
  nodes: [
    { kind: "agent", id: AGENT, x: 40, y: 40, width: 140, height: 56, z: 0,
      label: "agent", agentKey: "local:default", host: "acceptance", overseer: false,
      bindingId: "work-acceptance-agent", harness: "claude" },
    { kind: "task", id: TASKS, x: 240, y: 40, width: 160, height: 80, z: 1 },
    { kind: "artifacts", id: ARTS, x: 640, y: 40, width: 160, height: 80, z: 3 },
    { kind: "region", id: "region", x: 0, y: 0, width: 900, height: 200, z: 4,
      label: "Acceptance", hold: false, instruction: "accept the work plane" },
    // A region beside it, on no line with it: a seat here reaches nothing in
    // Acceptance. A node in no region is at the root and reaches everything.
    { kind: "region", id: "elsewhere", x: 1200, y: 0, width: 600, height: 200, z: 5,
      label: "Elsewhere", hold: false, instruction: "out of reach of the acceptance work" },
  ],
  // The seat reaches Tasks and Artifacts through the region, with no wire (01).
  wires: [],
});

/** The homes a CLI the net spawns reads; each must lie inside the run's sandbox. */
export const SANDBOXED_HOMES = ["JUNTO_WORK_HOME", "JUNTO_BROWSER_HOME"] as const;

/**
 * The env a CLI the net spawns runs with: the browser home in the sandbox
 * unless one inside it is named, and every home checked inside it. A home
 * outside the sandbox, the operator's real app at ~/ among them, is refused
 * before anything is spawned.
 */
export const sandboxedCliEnv = (sandbox: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const held: NodeJS.ProcessEnv = { ...env, JUNTO_BROWSER_HOME: env.JUNTO_BROWSER_HOME ?? join(sandbox, "browser-home") };
  const inside = resolve(sandbox) + sep;
  for (const key of SANDBOXED_HOMES) {
    const home = held[key];
    if (home === undefined || !resolve(home).startsWith(inside)) {
      throw new Error(`work CLI acceptance refuses ${key}=${String(home)}: it is outside the sandbox ${sandbox}`);
    }
  }
  return held;
};

/** The one way the net spawns the CLI: every call's env through sandboxedCliEnv. */
const runCli = (
  processPlane: AppProcessPlane,
  sandbox: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<WorkCliCommandResult> =>
  runBoundedWorkCliCommand(processPlane, {
    command: CLI,
    args,
    env: sandboxedCliEnv(sandbox, env),
    cwd,
  });

/** One raw request frame on the work socket, and the first response line. */
const socketFrame = async (
  socketPath: string,
  request: Readonly<Record<string, unknown>>,
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
        rejectReceipt(new Error(`work control ${String(request.op)} frame timed out`));
      }, SOCKET_TIMEOUT_MS);
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (frame.byteLength + part.byteLength > WORK_MAX_FRAME_BYTES) {
          rejectReceipt(new Error("work control response exceeded its frame bound"));
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

export const runWorkCliAcceptance = async () => {
  if (!existsSync(CLI)) {
    throw new Error("missing dist/junto — run JUNTO_FEATURE_PROFILE=all-on bun run cli:build");
  }
  // The core reads its flags when it loads, so they come from the run's env.
  if (!TASKS_ENABLED || !ARTIFACTS_ENABLED) {
    throw new Error("run the acceptance core with JUNTO_TASKS=1 JUNTO_ARTIFACTS=1 (see the header)");
  }

  const root = await mkdtemp(join(tmpdir(), "junto-work-acc-"));
  const workHome = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(workHome, { recursive: true });
  mkdirSync(outside, { recursive: true });

  const previousWorkHome = process.env.JUNTO_WORK_HOME;
  process.env.JUNTO_WORK_HOME = workHome;

  const processPlane = createAppProcessPlane({
    termGraceMs: CLI_TERM_GRACE_MS,
    killGraceMs: CLI_KILL_CLOSE_GRACE_MS,
  });
  const contentLive = makeContentServiceLive({
    root: join(root, "content"),
    skipInlineMediaMigration: true,
  });
  // The 0.10 stores the resource verbs write through, each ruling recorded
  // through the work store, as the running core composes them (core-product.ts).
  const recorded = Layer.provide(RulingRecorderLive, WorkRepositoryLive);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      AgentSignalRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      contentLive,
      recorded,
      OpRepositoryLive,
      makeAutomationRepositoryLive(),
      Layer.provide(TaskRepositoryLive, recorded),
      Layer.provide(ArtifactRepositoryLive, Layer.merge(recorded, contentLive)),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  // This machine edits the acceptance canvas and links no peer: every write is ruled here.
  // The ruler reads the model, so it goes over the canvases (core-product.ts).
  const canvasesLive = Layer.provideMerge(Layer.provide(ModelLive, WorkModelDependentsLive), repositoriesLive);
  const ruledLive = Layer.provideMerge(
    Layer.mergeAll(makeResourceSubmitLayer(() => false), ResourceRulerLive),
    canvasesLive,
  );
  const workLive = Layer.provideMerge(
    WorkLive,
    ruledLive,
  );
  // The occupy service the overseer composition runs over, as core-product.ts has it.
  const runtime = ManagedRuntime.make((
    Layer.provideMerge(ActorSeatOccupyLive, Layer.mergeAll(workLive, PausePlaneAllPlaying)) as never),
  );
  // Name the disposable machine before authoring its canvas.
  const settings = await runtime.runPromise(SettingsService);
  const machines = await runtime.runPromise(MachineRepository);
  await runtime.runPromise(machines.configureName("acceptance"));
  await runtime.runPromise(settings.setMachinePreferences({ supervisedPreferred: true }));

  // Author only topology, then seed fixed acceptance work through explicit
  // WorkRepository verbs. The canvas never carries a durable work projection.
  const model = await runtime.runPromise(ModelService);
  await runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)({ _tag: "CreateCanvas", canvas: CANVAS }), "operator"));
  await runtime.runPromise(model.command(seed(), "operator"));
  const canvas = await runtime.runPromise(model.canvas(CANVAS));
  const basis = Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind: "canvas", canvasName: CANVAS, seq: canvas.seq,
  });
  const taskSink = { canvasName: CANVAS, nodeId: TASKS };
  const dependencyScope = createCanvasTaskDependencyScopeCapability({
    canvas,
    authoringSink: taskSink,
  });
  const repository = await runtime.runPromise(WorkRepository);
  for (const [id, messageId, brief] of [
    ["t1", "m0", "ship it"],
    ["t2", "m1", "also this"],
  ] as const) {
    await runtime.runPromise(
      repository.createTask({
        sink: taskSink,
        basis,
        dependencyScope,
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
  // Admission is the generation credential.
  const credentials = makeSeatCredentialRegistry();
  const mint = mintSeatCredential();
  if (!credentials.publish(mint, { agentKey: "local:default" })) {
    throw new Error("acceptance credential publish failed");
  }

  let server: Awaited<ReturnType<typeof startWorkControlServer>> | undefined;
  let overseer: OverseerComposition | undefined;
  let primaryFailed = false;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    // The overseer surface the app composes (index.ts): without it every
    // overseer verb answers RuntimeDown. This core has no window to capture.
    overseer = await composeOverseer({
      run: (effect, options) => runtime.runPromise(effect as never, options),
      captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "the acceptance core has no window" }),
    });
    server = await startWorkControlServer({
      version: "acceptance",
      workHome,
      home: root,
      credentials,
      run: (effect) => runtime.runPromise(effect),
      onOverseer: overseer.onOverseer,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // dist/junto reads these at run time: the 0.10 verbs the net drives.
      ...CLI_FEATURES,
      JUNTO_WORK_HOME: workHome,
      // Over whatever the shell had: no call reaches the operator's app.
      JUNTO_BROWSER_HOME: join(root, "browser-home"),
      [WORK_TOKEN_ENV]: mint.credential,
    };

    const socketPath = server.socketPath;
    const sockMode = (await stat(socketPath)).mode & 0o777;
    log(
      "A3 perms",
      JSON.stringify({
        socket: sockMode.toString(8),
        socket_path: server.socketPath,
      }),
    );

    const cliAs = (args: ReadonlyArray<string>, as?: AcceptanceSeat, extra?: NodeJS.ProcessEnv) =>
      runCli(
        processPlane,
        root,
        [...args],
        { ...env, ...extra, ...(as === undefined ? {} : { [WORK_TOKEN_ENV]: seatTokens.get(as.agentKey) }) },
        outside,
      );
    const seatTokens = new Map<string, string>([["local:default", mint.credential]]);
    const addSeat = async (
      nodeId: string,
      at: { readonly x: number; readonly y: number },
      options?: { readonly overseer?: boolean },
    ): Promise<AcceptanceSeat> => {
      const agentKey = `local:${nodeId}`;
      await runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)({
        _tag: "Add",
        canvas: CANVAS,
        nodes: [{ kind: "agent", id: nodeId, x: at.x, y: at.y, width: 140, height: 56, z: 10,
          label: nodeId, agentKey, host: "acceptance", overseer: false, bindingId: `work-acceptance-${nodeId}`, harness: "claude" }],
        wires: [],
      }), "operator"));
      // The operator's grant, as the overseer toggle sends it (overseer-set.ts):
      // a seat is made plain, and only the operator makes it an overseer.
      if (options?.overseer === true) {
        await runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)({
          _tag: "GrantOverseer",
          canvas: CANVAS,
          id: nodeId,
          overseer: true,
        }), "operator"));
      }
      const seatMint = mintSeatCredential();
      if (!credentials.publish(seatMint, { agentKey })) throw new Error(`acceptance credential publish failed for ${nodeId}`);
      seatTokens.set(agentKey, seatMint.credential);
      return { nodeId, agentKey };
    };
    const context: AcceptanceContext = {
      canvas: CANVAS,
      nodes: { agent: AGENT, tasks: TASKS, artifacts: ARTS, region: "region", elsewhere: "elsewhere" },
      cli: cliAs,
      call: async (op, args, as) =>
        JSON.parse(await socketFrame(socketPath, {
          token: as === undefined ? mint.credential : seatTokens.get(as.agentKey),
          op,
          args,
        })),
      addSeat,
      operator: async (command) => {
        await runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)(command), "operator"));
      },
      runtime: runtime as never,
      log,
      outside,
    };
    const verdicts: CaseVerdict[] = [];
    for (const area of AREAS) {
      try {
        verdicts.push(...(await area.run(context)));
      } catch (error) {
        verdicts.push({ area: area.name, name: "area threw", status: "fail", detail: String(error) });
      }
    }

    const wrongTok = await socketFrame(server.socketPath, { token: "0".repeat(64), op: "ping" });
    log("A3 wrong token", wrongTok);
    verdicts.push(
      wrongTok.includes("AuthError")
        ? { area: "transport", name: "wrong token", status: "pass" }
        : { area: "transport", name: "wrong token", status: "fail", detail: wrongTok },
      sockMode === 0o600
        ? { area: "transport", name: "socket 0600", status: "pass" }
        : { area: "transport", name: "socket 0600", status: "fail", detail: sockMode.toString(8) },
    );

    log(
      "canvas after",
      JSON.stringify({
        tasks: (await runtime.runPromise(repository.taskLane(CANVAS, TASKS))).map((task) => ({ id: task.id, state: task.state })),
        artifacts: (await runtime.runPromise(repository.artifactLane(CANVAS, ARTS))).map((artifact) => ({ id: artifact.artifactId, name: artifact.name })),
      }, null, 2),
    );

    console.log("\n=== verdict ===");
    console.log(JSON.stringify(verdicts, null, 2));
    const failed = verdicts.filter((verdict) => verdict.status === "fail");
    const pending = verdicts.filter((verdict) => verdict.status === "pending");
    console.log(`${String(verdicts.length - failed.length - pending.length)} pass, ${String(failed.length)} fail, ${String(pending.length)} pending`);
    if (failed.length > 0) {
      throw new Error(`work CLI acceptance verdict failed: ${failed.map((verdict) => `${verdict.area}/${verdict.name}`).join(", ")}`);
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
    overseer?.dispose();
    try {
      await runtime.dispose();
    } catch (error) {
      cleanupFailures.push(new Error("work CLI acceptance runtime dispose failed", { cause: error }));
    }
    if (previousWorkHome === undefined) delete process.env.JUNTO_WORK_HOME;
    else process.env.JUNTO_WORK_HOME = previousWorkHome;
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
  void runWorkCliAcceptance().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
