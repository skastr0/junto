/**
 * Per-test sandbox: a throwaway temp root holding the Electron user-data
 * dir, the agent-facing canvases directory, and a sandboxed HOME — plus
 * fixture builders. Nothing here ever reads or writes the operator's real
 * ~/.vellum-command or userData; every path lives under os.tmpdir().
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type {
  Task,
  Artifact,
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  TextNode,
} from "../../src/shared/canvas";
import {
  CanvasesLive,
  CanvasesService,
} from "../../src/main/vellum/canvases";
import {
  makeStateEngineLive,
} from "../../src/main/vellum/state/engine";
import { StateEngine } from "../../src/main/vellum/state/service";
import {
  SettingsLive,
  SettingsService,
} from "../../src/main/vellum/settings/service";
import { makeHostsRegistry } from "../../src/main/vellum/hosts/registry";
import type { RemoteHost } from "../../src/shared/remote-hosts";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../../src/main/vellum/work/repository";
import {
  StationRepository,
  StationRepositoryLive,
} from "../../src/main/vellum/station/repository";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../../src/main/vellum/station/fleet-target-repository";
import {
  compileActorSeatRegistry,
} from "../../src/main/vellum/station/actor-seat-compiler";
import {
  IntentFactBasis,
  type ActorRef,
} from "../../src/shared/work-protocol";

export interface Sandbox {
  readonly root: string;
  readonly userDataDir: string;
  readonly canvasesDir: string;
  readonly homeDir: string;
}

/**
 * macOS caps AF_UNIX socket paths at roughly 104 bytes (sun_path). The work,
 * station, canvas, term, and browser control sockets all live under
 * `<home>/.vellum-command/<plane>/control.sock`; with the canonical renamed
 * home that is 35 bytes of suffix, so the temp root must leave room. A stock
 * `os.tmpdir()` on macOS expands to a long /var/folders/... path and pushes
 * every control socket over the limit — bind() then fails EINVAL and the app
 * fail-closes at boot. Prefer `os.tmpdir()`, but fall back to the short
 * `/tmp` root (the same trick the browser containment probe uses) whenever
 * the deepest control socket would not fit.
 */
const controlSocketFits = (root: string): boolean => {
  // Longest control plane suffix under the canonical home.
  const suffix = join("home", ".vellum-command", "station", "control.sock");
  // 6 random chars from mkdtemp + the "vellum-command-e2e-" prefix.
  const longest = join(root, "vellum-command-e2e-abcdef", suffix);
  return Buffer.byteLength(longest) <= 103;
};

export const createSandbox = async (): Promise<Sandbox> => {
  const tempRoot = controlSocketFits(tmpdir()) ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(tempRoot, "vellum-command-e2e-"));
  const userDataDir = join(root, "user-data");
  const homeDir = join(root, "home");
  const vellumDir = join(homeDir, ".vellum-command");
  const canvasesDir = join(vellumDir, "canvases");
  const stateDir = join(vellumDir, "state");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(canvasesDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  return {
    root,
    userDataDir,
    canvasesDir,
    homeDir,
  };
};

/** Best-effort recursive removal — never throws (temp cleanup is not load-bearing). */
export const destroySandbox = async (sandbox: Sandbox): Promise<void> => {
  await rm(sandbox.root, { recursive: true, force: true }).catch(() => undefined);
};

/**
 * Seed through the same scoped Effect services used by Electron, then close
 * the SQLite owner before Electron starts. CanvasesService strips runtime
 * overlays at the authorial boundary; each fixture item is then committed by
 * its explicit WorkRepository verb. No `.canvas`, generic work mutation,
 * manifest, pointer, or seal exists as an alternate authority.
 */
export const writeFixtureCanvas = async (
  sandbox: Sandbox,
  name: string,
  doc: CanvasDoc,
  databasePath?: string,
): Promise<void> => {
  const previousCanvasesDir = process.env.VELLUM_COMMAND_CANVASES_DIR;
  process.env.VELLUM_COMMAND_CANVASES_DIR = sandbox.canvasesDir;

  // Default to the sandbox's canonical product database. Demo-mode apps
  // isolate product state in a process-minted ephemeral SQLite file, so
  // launchVellum re-seeds the same fixtures into that database after boot.
  const state = makeStateEngineLive(
    databasePath ??
      join(sandbox.homeDir, ".vellum-command", "state", "vellum-command.db"),
  );
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      SettingsLive,
      StationFleetTargetRepositoryLive,
    ),
    state,
  );
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  const runtime = ManagedRuntime.make(canvases);

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const canvasService = yield* CanvasesService;
        const workRepository = yield* WorkRepository;
        const stations = yield* StationRepository;
        const settings = yield* SettingsService;
        const fleetTargets = yield* StationFleetTargetRepository;

        yield* settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        });
        const installationId = yield* stations.installationId;

        // The actor-seat compiler resolves every agent seat against the
        // station topology, so multi-host fixtures must bind each host they
        // place agents on BEFORE the first portfolio read. "local" is the
        // configured Command Center host; every other agent host is bound
        // as a fleet target of this sandbox installation (same rows the
        // app reads at boot).
        const agentHosts = new Set<string>();
        for (const node of doc.nodes) {
          if (node.ether?.entity?.kind !== "agent") continue;
          const host =
            typeof node.ether.host === "string" &&
            node.ether.host.trim().length > 0
              ? node.ether.host.trim()
              : "local";
          agentHosts.add(host);
        }
        const installationByHostId = new Map<string, typeof installationId>([
          ["local", installationId],
        ]);
        for (const host of agentHosts) {
          if (host === "local") continue;
          yield* fleetTargets.bind({
            hostId: host,
            stationInstallationId: installationId,
          });
          installationByHostId.set(host, installationId);
        }

        yield* canvasService.write(name, doc);
        const intentWitness = yield* canvasService.activeIntentWitness();
        const basis = Schema.decodeUnknownSync(IntentFactBasis, {
          onExcessProperty: "error",
        })({
          kind: "authorial-intent",
          generation: intentWitness.generation,
          contentSha256: intentWitness.contentSha256,
        });

        const actorRefs: ReadonlyArray<ActorRef> =
          compileActorSeatRegistry(
            new Map([[name, doc]]),
            installationByHostId,
          ).flatMap((seat) =>
            seat.refs.map((ref) => ({
              seatId: seat.seatId,
              canvasName: ref.canvasName,
              nodeId: ref.nodeId,
            }))
          );
        const adjacentActor = (sinkNodeId: string): ActorRef => {
          const adjacentNodeIds = new Set(
            doc.edges.flatMap((edge) =>
              edge.fromNode === sinkNodeId
                ? [edge.toNode]
                : edge.toNode === sinkNodeId
                  ? [edge.fromNode]
                  : []
            ),
          );
          const candidates = actorRefs.filter(
            (actor) =>
              actor.nodeId === sinkNodeId ||
              adjacentNodeIds.has(actor.nodeId),
          );
          if (candidates.length !== 1) {
            throw new Error(
              `fixture ${JSON.stringify(name)} sink ${JSON.stringify(sinkNodeId)} ` +
                `requires exactly one local compiled actor, found ${String(candidates.length)}`,
            );
          }
          return candidates[0]!;
        };
        const actorForTask = (
          sinkNodeId: string,
          task: Task,
        ): ActorRef => {
          if (task.claimedBy === undefined) return adjacentActor(sinkNodeId);
          // Fixtures claim by the authored node id (or the derived seat id);
          // translate to the compiled ActorSeatId the work plane stores.
          const claimant = actorRefs.filter(
            (actor) =>
              actor.seatId === task.claimedBy || actor.nodeId === task.claimedBy,
          );
          if (claimant.length !== 1) {
            throw new Error(
              `fixture task ${JSON.stringify(task.id)} claimant is not one local compiled actor`,
            );
          }
          return claimant[0]!;
        };

        for (const node of doc.nodes) {
          const sink = { canvasName: name, nodeId: node.id };
          for (const task of node.ether?.tasks?.items ?? []) {
            const {
              state: targetState,
              claimedBy: targetClaimant,
              ...submittedBody
            } = task;
            if (targetState === "submitted" && targetClaimant !== undefined) {
              throw new Error(
                `fixture submitted task ${JSON.stringify(task.id)} cannot carry a claimant`,
              );
            }
            yield* workRepository.createTask({
              sink,
              basis,
              task: {
                ...submittedBody,
                state: "submitted",
              },
            });

            // auth-required is residual-only; fixture seeds collapse to input-required.
            const effectiveState =
              targetState === "auth-required" ? "input-required" : targetState;
            const requiresClaim =
              effectiveState === "working" ||
              effectiveState === "input-required" ||
              targetClaimant !== undefined;
            if (requiresClaim) {
              yield* workRepository.claimLocalTask({
                sink,
                basis,
                taskId: task.id,
                actor: actorForTask(node.id, task),
              });
            }
            if (
              effectiveState !== "submitted" &&
              effectiveState !== "working"
            ) {
              yield* workRepository.transitionTask({
                sink,
                basis,
                taskId: task.id,
                state: effectiveState,
              });
            }
          }

          for (const request of node.ether?.requests?.items ?? []) {
            if (
              request.state !== "input-required" &&
              request.state !== "auth-required" &&
              request.state !== "completed" &&
              request.state !== "rejected"
            ) {
              throw new Error(
                `fixture request ${JSON.stringify(request.id)} has unsupported state ${JSON.stringify(request.state)}`,
              );
            }
            const actor = actorForTask(node.id, request);
            const {
              state: targetState,
              claimedBy: _targetClaimant,
              response,
              ...requestBody
            } = request;
            yield* workRepository.createRequest({
              sink,
              basis,
              request: {
                ...requestBody,
                // Retired auth-required seeds collapse to input-required.
                state: "input-required",
                claimedBy: actor.seatId,
              },
              raisedBy: actor,
            });
            if (targetState === "completed" || targetState === "rejected") {
              yield* workRepository.resolveRequest({
                sink,
                basis,
                requestId: request.id,
                response: response ?? "fixture resolved",
                disposition: targetState,
              });
            }
          }

          for (const message of node.ether?.messages?.items ?? []) {
            yield* workRepository.appendMessage({
              sink,
              basis,
              message,
              sentBy: adjacentActor(node.id),
              destination: { kind: "mailbox" },
            });
          }

          for (const artifact of node.ether?.artifacts?.items ?? []) {
            yield* workRepository.publishArtifact({
              sink,
              basis,
              artifact,
              publishedBy: adjacentActor(node.id),
            });
          }
        }
      }),
    );
  } finally {
    try {
      await runtime.dispose();
    } finally {
      if (previousCanvasesDir === undefined) {
        delete process.env.VELLUM_COMMAND_CANVASES_DIR;
      } else {
        process.env.VELLUM_COMMAND_CANVASES_DIR = previousCanvasesDir;
      }
    }
  }
};

/**
 * Remove canvases from an explicit database, keeping only the seeded names.
 * Demo-mode apps mint an ephemeral product database and create an empty
 * default canvas at first boot; launchVellum removes it so the renderer
 * boots onto the seeded canvas instead of the empty default.
 */
export const removeFixtureCanvases = async (
  sandbox: Sandbox,
  databasePath: string,
  keep: ReadonlySet<string>,
): Promise<void> => {
  const previousCanvasesDir = process.env.VELLUM_COMMAND_CANVASES_DIR;
  process.env.VELLUM_COMMAND_CANVASES_DIR = sandbox.canvasesDir;
  const state = makeStateEngineLive(databasePath);
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      SettingsLive,
      StationFleetTargetRepositoryLive,
    ),
    state,
  );
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  const runtime = ManagedRuntime.make(canvases);
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const canvasService = yield* CanvasesService;
        const documents = yield* canvasService.liveDocuments();
        for (const { canvasName } of documents) {
          if (keep.has(canvasName)) continue;
          yield* canvasService.remove(canvasName);
        }
      }),
    );
  } finally {
    try {
      await runtime.dispose();
    } finally {
      if (previousCanvasesDir === undefined) {
        delete process.env.VELLUM_COMMAND_CANVASES_DIR;
      } else {
        process.env.VELLUM_COMMAND_CANVASES_DIR = previousCanvasesDir;
      }
    }
  }
};

/** Seed enrolled hosts into the same explicit SQLite database Electron opens. */
export const writeFixtureHosts = async (
  sandbox: Sandbox,
  hosts: ReadonlyArray<RemoteHost>,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    makeStateEngineLive(
      join(sandbox.homeDir, ".vellum-command", "state", "vellum-command.db"),
    ),
  );
  try {
    const state = await runtime.runPromise(StateEngine);
    const registry = makeHostsRegistry(state, (e) => Effect.runPromise(e));
    for (const host of hosts) {
      await registry.upsert(host);
    }
  } finally {
    await runtime.dispose();
  }
};

// --- fixture builders --------------------------------------------------------

/** A free (no ether.entity) text node — renders inline as a note. */
export const textNode = (id: string, text: string, x = 0, y = 0): TextNode => ({
  id,
  type: "text",
  text,
  x,
  y,
  width: 240,
  height: 120,
});

/** Vellum Command-owned native terminal node (entity.kind terminal + ether.terminal).
 * Session starts on open / create — no Start button on the card. */
export const terminalTextNode = (input: {
  readonly id: string;
  readonly bindingId: string;
  readonly label: string;
  readonly host?: string;
  readonly launch?: {
    readonly kind: "shell" | "command" | "harness";
    readonly argv?: readonly string[];
    readonly cwd?: string;
  };
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 260,
  height: 110,
  ether: {
    entity: { kind: "terminal" },
    host: input.host ?? "local",
    terminal: {
      bindingId: input.bindingId,
      label: input.label,
      ...(input.launch ? { launch: { ...input.launch, argv: input.launch.argv ? [...input.launch.argv] : undefined } } : {}),
    },
  },
});

/** A herdr-bound node matching the shape the demo engine's own scenarios use
 * (src/renderer/demo/scenarios/trailer-60.ts) — single fixed workspace/tab. */
export const herdrTextNode = (input: {
  readonly id: string;
  readonly host: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly label: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 260,
  height: 110,
  ether: {
    entity: { kind: "herdr" },
    herdr: {
      host: input.host,
      session: null,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: input.paneId,
      terminalId: input.terminalId,
      label: input.label,
    },
  },
});

/** A managed agent seat for scripted scenarios.
 * `key` is the process-bind agent key (`<host>:<profile>`); the same stable
 * key is its fixture binding identity. */
export const agentTextNode = (input: {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly host?: string;
  readonly harness?: import("../../src/shared/managed-terminal-templates").HarnessId;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 96,
  ether: {
    entity: { kind: "agent", name: input.key },
    host: input.host ?? "local",
    terminal: {
      bindingId: input.key,
      harness: input.harness ?? "codex",
    },
  },
});

export const canvasDoc = (
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[] = [],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

// --- work-plane fixtures (no legacy checklist shape) --------------------

/**
 * Fixture claim by authored node id. Branded as the derived ActorSeatId so
 * typed Task fixtures compile; the sandbox resolves node id -> compiled seat
 * id in actorForTask before any schema decode.
 */
export const claimByNodeId = (nodeId: string): Task["claimedBy"] =>
  nodeId as Task["claimedBy"];

export const taskItem = (
  id: string,
  brief: string,
  state: Task["state"] = "submitted",
): Task => ({
  id,
  state,
  history: [
    {
      messageId: `${id}-m0`,
      role: "user",
      parts: [{ kind: "text", text: brief }],
      taskId: id,
      contextId: "e2e",
    },
  ],
});

/** Empty tasks node — work ops fill ether.tasks via WorkService. */
export const tasksNode = (input: {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<Task>;
}): TextNode => ({
  id: input.id,
  type: "text",
  text:
    input.items && input.items.length > 0
      ? input.items
          .map((t) => {
            const part = t.history[0]?.parts.find((p) => p.kind === "text");
            return part && part.kind === "text" ? part.text : t.id;
          })
          .join("\n")
      : "tasks",
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [...(input.items ?? [])] },
  },
});

export const requestsNode = (input: {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<Task>;
}): TextNode => {
  const items = input.items ?? [];
  const pending = items.filter((t) => t.state === "input-required").length;
  return {
    id: input.id,
    type: "text",
    text: `${pending} pending`,
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: 240,
    height: 120,
    ether: {
      entity: { kind: "requests" },
      requests: { items: [...items] },
    },
  };
};

export const artifactsNode = (input: {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<Artifact>;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: "artifacts",
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "artifacts" },
    artifacts: { items: [...(input.items ?? [])] },
  },
});

/** Soft project-like blockable target (kind project; no private-source bindings). */
export const projectNode = (input: {
  readonly id: string;
  readonly name: string;
  readonly label?: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label ?? input.name,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "project", name: input.name } },
});

export const tasksCriteriaEdge = (
  id: string,
  fromNode: string,
  toNode: string,
): CanvasEdge => ({
  id,
  fromNode,
  toNode,
  fromSide: "right",
  toSide: "left",
  ether: { stops: { mode: "tasks" } },
});
