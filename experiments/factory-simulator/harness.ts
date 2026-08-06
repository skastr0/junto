import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { runBoundedWorkCliCommand } from "../../scripts/work-cli-acceptance";
import { allSchemas } from "../../src/cli/core/discovery";
import { createAppProcessPlane } from "../../src/main/vellum/app-process-plane";
import { CanvasesLive, CanvasesService } from "../../src/main/vellum/canvases";
import { makeContentServiceLive } from "../../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../../src/main/vellum/install-ops/engine";
import { managedTaskDeliveryId } from "../../src/main/vellum/kernel/service";
import { PausePlaneAllPlaying } from "../../src/main/vellum/pause-plane";
import { makeProcessIdentityMap } from "../../src/main/vellum/process-identity";
import { makeStateEngineLive } from "../../src/main/vellum/state/engine";
import { StationFleetTargetRepositoryLive } from "../../src/main/vellum/station/fleet-target-repository";
import { StationRepositoryLive } from "../../src/main/vellum/station/repository";
import { StationLivePeerRegistryLive } from "../../src/main/vellum/station/session-registry";
import { ManagedTerminalDrive } from "../../src/main/vellum/term/drive";
import {
  startWorkControlServer,
  type WorkControlServer,
} from "../../src/main/vellum/work/control";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../../src/main/vellum/work/repository";
import { WorkLive, WorkService } from "../../src/main/vellum/work/service";
import { SettingsLive, SettingsService } from "../../src/main/vellum/settings/service";
import type { CanvasDoc } from "../../src/shared/canvas";
import { buildFactoryClaimPrompt } from "../../src/shared/factory-claim-prompt";
import { selectFactoryClaims } from "../../src/shared/factory-tick";
import { claimedByOf } from "../../src/shared/task";
import {
  type WorkOpName,
} from "../../src/shared/work-control";
import { isTargetWorkOp } from "../../src/shared/physics";
import {
  IntentFactBasis,
  type IntentFactBasis as IntentFactBasisValue,
} from "../../src/shared/work-protocol";
import type { Task } from "../../src/shared/work-model";

export interface SeedTask {
  readonly sinkNodeId: string;
  readonly task: Task;
}

export interface ScriptedCliCall {
  readonly commandId: WorkOpName;
  readonly input?: unknown;
}

export interface ScenarioTick {
  readonly commands?: ReadonlyArray<ScriptedCliCall>;
}

export interface FactoryScenario {
  readonly name: string;
  readonly canvasName: string;
  readonly canvas: CanvasDoc;
  readonly actor: {
    readonly nodeId: string;
    readonly agentKey: string;
    readonly bindingId: string;
  };
  readonly tasks: ReadonlyArray<SeedTask>;
  readonly ticks: ReadonlyArray<ScenarioTick>;
}

export type ScenarioEvent =
  | { readonly tick: number; readonly kind: "claim"; readonly taskId: string; readonly actorNodeId: string }
  | { readonly tick: number; readonly kind: "pty.write"; readonly bindingId: string; readonly data: string }
  | { readonly tick: number; readonly kind: "hook.turn-start"; readonly bindingId: string }
  | { readonly tick: number; readonly kind: "injection.accepted"; readonly taskId: string; readonly deliveryId: string; readonly prompt: string }
  | { readonly tick: number; readonly kind: "cli.call"; readonly commandId: WorkOpName; readonly input: unknown }
  | { readonly tick: number; readonly kind: "cli.result"; readonly commandId: WorkOpName; readonly exitCode: number; readonly response: CliEnvelope }
  | { readonly tick: number; readonly kind: "snapshot"; readonly tasks: Readonly<Record<string, string>> };

export type CliEnvelope =
  | { readonly ok: true; readonly command: string; readonly data: unknown }
  | {
      readonly ok: false;
      readonly command?: string;
      readonly error: { readonly type: string; readonly message?: string };
    };

export interface ScenarioRun {
  readonly events: ReadonlyArray<ScenarioEvent>;
  readonly snapshots: ReadonlyArray<Extract<ScenarioEvent, { readonly kind: "snapshot" }>>;
}

const makeRuntime = (root: string) => {
  const state = makeStateEngineLive(join(root, "state", "vellum.db"));
  const installOps = makeInstallOpsLive(join(root, "state", "install-ops.db"));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({
        root: join(root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(state, installOps),
  );
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  const work = Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(canvases, StationLivePeerRegistryLive),
  );
  return ManagedRuntime.make(Layer.mergeAll(work, PausePlaneAllPlaying));
};

type SimulatorRuntime = ReturnType<typeof makeRuntime>;

const intentBasis = async (runtime: SimulatorRuntime): Promise<IntentFactBasisValue> => {
  const canvases = await runtime.runPromise(CanvasesService);
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  return Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
    kind: "authorial-intent",
    ...witness,
  });
};

const decodeCliInput = (
  commandId: WorkOpName,
  input: unknown,
): { readonly input: unknown; readonly argv: ReadonlyArray<string> } => {
  const contract = allSchemas.find(({ command_id: candidate }) => candidate === commandId);
  if (contract === undefined) {
    throw new Error(`factory simulator has no CLI schema for ${commandId}`);
  }
  const decoded = Schema.decodeUnknownResult(contract.schema, {
    onExcessProperty: "error",
  })(input);
  if (Result.isFailure(decoded)) {
    throw new Error(`factory simulator input does not satisfy ${contract.schema_id}`);
  }
  return {
    input: decoded.success,
    argv: [...contract.command.split(" "), JSON.stringify(decoded.success)],
  };
};

const decodeCliEnvelope = (stdout: string, stderr: string): CliEnvelope => {
  const text = stdout.trim() || stderr.trim();
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    throw new Error("factory simulator CLI returned a non-envelope response");
  }
  return parsed as CliEnvelope;
};

const resolveBun = (): string => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "bun");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed PATH entries. No shell lookup is involved.
    }
  }
  throw new Error("factory simulator requires bun on PATH to run the real CLI");
};

const taskSnapshot = (doc: CanvasDoc): Readonly<Record<string, string>> =>
  Object.fromEntries(
    doc.nodes.flatMap((node) =>
      (node.ether?.tasks?.items ?? []).map((task) => [task.id, task.state] as const),
    ),
  );

export const runFactoryScenario = async (
  scenario: FactoryScenario,
): Promise<ScenarioRun> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-factory-sim-"));
  mkdirSync(join(root, "work"), { recursive: true });
  const runtime = makeRuntime(root);
  const processPlane = createAppProcessPlane();
  const bun = resolveBun();
  let server: WorkControlServer | undefined;
  const events: ScenarioEvent[] = [];
  let activeTick = 0;
  const drive = new ManagedTerminalDrive({
    isSeatIdle: () => true,
    write: (bindingId, data) => {
      events.push({ tick: activeTick, kind: "pty.write", bindingId, data });
      return true;
    },
    stallTimeoutMs: 1_000,
  });

  try {
    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write(scenario.canvasName, scenario.canvas));
    const repository = await runtime.runPromise(WorkRepository);
    for (const seed of scenario.tasks) {
      await runtime.runPromise(
        repository.createTask({
          sink: { canvasName: scenario.canvasName, nodeId: seed.sinkNodeId },
          basis: await intentBasis(runtime),
          task: seed.task,
        }),
      );
    }

    const processMap = makeProcessIdentityMap();
    if (!processMap.bind(process.pid, { agentKey: scenario.actor.agentKey })) {
      throw new Error("factory simulator could not bind its fake actor process");
    }
    server = await startWorkControlServer({
      version: "factory-simulator",
      home: root,
      workHome: join(root, "work"),
      processMap,
      readPeerPid: () => process.pid,
      run: (effect) => runtime.runPromise(effect),
    });
    const work = await runtime.runPromise(WorkService);

    for (const [index, tick] of scenario.ticks.entries()) {
      activeTick = index + 1;
      let read = await runtime.runPromise(canvases.read(scenario.canvasName));
      const actor = read.actorRefs.find(
        (candidate) => candidate.nodeId === scenario.actor.nodeId,
      );
      if (actor === undefined) throw new Error("factory simulator actor did not compile");

      const selections = selectFactoryClaims(
        read.doc,
        scenario.canvasName,
        (candidate) =>
          candidate.nodeId === actor.nodeId && candidate.canvasName === actor.canvasName
            ? actor
            : undefined,
      );
      for (const selection of selections) {
        const claimed = await runtime.runPromise(
          work.workTaskClaim(
            selection.sink.canvasName,
            selection.sink.nodeId,
            selection.task.itemId,
            selection.actor,
          ),
        );
        if (!claimed.ok) throw new Error(`factory simulator claim failed: ${claimed.message}`);
        events.push({
          tick: activeTick,
          kind: "claim",
          taskId: selection.task.itemId,
          actorNodeId: selection.actor.nodeId,
        });
      }

      read = await runtime.runPromise(canvases.read(scenario.canvasName));
      for (const node of read.doc.nodes) {
        for (const task of node.ether?.tasks?.items ?? []) {
          if (task.state !== "working" || claimedByOf(task) !== actor.seatId) continue;
          const sink = { canvasName: scenario.canvasName, nodeId: node.id };
          const deliveryId = managedTaskDeliveryId(
            sink,
            task.id,
            actor.seatId,
            task.history.at(-1)?.messageId ?? task.id,
          );
          if (await runtime.runPromise(repository.hasAcceptedDelivery(sink, deliveryId))) continue;
          const prompt = buildFactoryClaimPrompt({ sinkNodeId: node.id, task });
          const acceptedPromise = drive.writePrompt(scenario.actor.bindingId, prompt);
          await new Promise<void>((resolve) => setImmediate(resolve));
          events.push({
            tick: activeTick,
            kind: "hook.turn-start",
            bindingId: scenario.actor.bindingId,
          });
          drive.onTurnStart(scenario.actor.bindingId);
          if (!(await acceptedPromise)) throw new Error("factory simulator PTY refused claim");
          await runtime.runPromise(
            repository.acceptDelivery({
              sink,
              basis: await intentBasis(runtime),
              receipt: {
                deliveryId,
                deliveredItem: { kind: "task", itemId: task.id, sink },
                actor,
                acceptedAt: new Date(activeTick * 1_000).toISOString(),
              },
            }),
          );
          events.push({
            tick: activeTick,
            kind: "injection.accepted",
            taskId: task.id,
            deliveryId,
            prompt,
          });
        }
      }

      for (const command of tick.commands ?? []) {
        if (command.commandId !== "preamble" && !isTargetWorkOp(command.commandId)) {
          throw new Error(`factory simulator v1 cannot drive ${command.commandId}`);
        }
        const decoded = decodeCliInput(command.commandId, command.input ?? {});
        events.push({
          tick: activeTick,
          kind: "cli.call",
          commandId: command.commandId,
          input: decoded.input,
        });
        const result = await runBoundedWorkCliCommand(processPlane, {
          command: bun,
          args: [join(process.cwd(), "src", "cli", "main.ts"), ...decoded.argv],
          cwd: process.cwd(),
          env: {
            ...process.env,
            VELLUM_COMMAND_WORK_HOME: server.workHome,
          },
        });
        const response = decodeCliEnvelope(result.stdout, result.stderr);
        events.push({
          tick: activeTick,
          kind: "cli.result",
          commandId: command.commandId,
          exitCode: result.code,
          response,
        });
      }

      read = await runtime.runPromise(canvases.read(scenario.canvasName));
      events.push({
        tick: activeTick,
        kind: "snapshot",
        tasks: taskSnapshot(read.doc),
      });
    }

    return {
      events,
      snapshots: events.filter(
        (event): event is Extract<ScenarioEvent, { readonly kind: "snapshot" }> =>
          event.kind === "snapshot",
      ),
    };
  } finally {
    drive.resetForTest();
    processPlane.beginShutdown();
    await Promise.all([server?.close(), processPlane.drainOnQuit()]);
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
};
