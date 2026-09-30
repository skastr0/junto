/**
 * Per-test sandbox: a throwaway temp root holding the Electron user-data
 * dir, the agent-facing canvases directory, and a sandboxed HOME — plus
 * fixture builders. Nothing here ever reads or writes the operator's real
 * ~/.junto or userData; every path lives under os.tmpdir().
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  NodeSide,
  TextNode,
} from "../../src/shared/canvas";
import { verbsForPair, type Verb } from "../../src/shared/physics/verbs";
import { resolveManagedLaunch } from "../../src/shared/managed-terminal-launch";
import {
  CanvasesLive,
  CanvasesService,
} from "../../src/main/junto/canvases";
import {
  makeStateEngineLive,
} from "../../src/main/junto/state/engine";
import {
  SettingsLive,
  SettingsService,
} from "../../src/main/junto/settings/service";
import { HostsPersistence, makeHostsRegistry } from "../../src/main/junto/hosts/registry";
import { HostsPersistenceLive } from "../../src/main/junto/hosts/service";
import type { RemoteHost } from "../../src/shared/remote-hosts";
import type { UsageState } from "../../src/shared/usage";
import type { AgentSignal } from "../../src/shared/agent-signals";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../../src/main/junto/work/repository";
import {
  StationRepository,
  StationRepositoryLive,
} from "../../src/main/junto/station/repository";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../../src/main/junto/station/fleet-target-repository";
import {
  compileActorSeatRegistry,
} from "../../src/main/junto/station/actor-seat-compiler";
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
 * `<home>/.junto/<plane>/control.sock`; with the canonical renamed
 * home that is 35 bytes of suffix, so the temp root must leave room. A stock
 * `os.tmpdir()` on macOS expands to a long /var/folders/... path and pushes
 * every control socket over the limit — bind() then fails EINVAL and the app
 * fail-closes at boot. Prefer `os.tmpdir()`, but fall back to the short
 * `/tmp` root (the same trick the browser containment probe uses) whenever
 * the deepest control socket would not fit.
 */
const controlSocketFits = (root: string): boolean => {
  // Longest control plane suffix under the canonical home.
  const suffix = join("home", ".junto", "station", "control.sock");
  // 6 random chars from mkdtemp + the "junto-e2e-" prefix.
  const longest = join(root, "junto-e2e-abcdef", suffix);
  return Buffer.byteLength(longest) <= 103;
};

export const createSandbox = async (): Promise<Sandbox> => {
  const tempRoot = controlSocketFits(tmpdir()) ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(tempRoot, "junto-e2e-"));
  const userDataDir = join(root, "user-data");
  const homeDir = join(root, "home");
  const juntoDir = join(homeDir, ".junto");
  const canvasesDir = join(juntoDir, "canvases");
  const stateDir = join(juntoDir, "state");
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
 * Historical rows are inert installed-state evidence. Seed invalid/expired
 * commercial data without restoring a runtime decoder or repository for it.
 * This engine is confined to the disposable sandbox and closes before launch.
 */
export const writeFixtureRetiredCommercialState = async (
  sandbox: Sandbox,
): Promise<void> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(
    join(sandbox.homeDir, ".junto", "state", "junto.db"),
  ));
  try {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function* () {
        const expired = JSON.stringify({
          provider: "retired-provider",
          licenseKey: "synthetic-expired-test-key",
          lastValidatedAt: "2000-01-01T00:00:00.000Z",
          validationResult: "invalid",
        });
        for (const [table, version] of [
          ["license_activation", 1],
          ["license_entitlement", 2],
        ] as const) {
          yield* sql`INSERT INTO ${sql(table)}
              (singleton, record_version, activated_license_json, updated_at)
             VALUES (1, ${version}, ${expired}, ${"2000-01-01T00:00:00.000Z"})`;
        }
      })),
    ));
  } finally {
    await runtime.dispose();
  }
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
  const previousCanvasesDir = process.env.JUNTO_CANVASES_DIR;
  process.env.JUNTO_CANVASES_DIR = sandbox.canvasesDir;

  // Default to the sandbox's canonical product database. Demo-mode apps
  // isolate product state in a process-minted ephemeral SQLite file, so
  // launchJunto re-seeds the same fixtures into that database after boot.
  const state = makeStateEngineLive(
    databasePath ??
      join(sandbox.homeDir, ".junto", "state", "junto.db"),
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

        const authorialDoc: CanvasDoc = {
          ...doc,
          nodes: doc.nodes.map((node) => {
            const ether = node.ether;
            if (ether === undefined) return node;
            const { messages: _messages, ...authorialEther } = ether;
            return { ...node, ether: authorialEther };
          }),
        };
        yield* canvasService.write(name, authorialDoc);
        const authority = yield* canvasService.authorityMaterialSnapshot();
        const basis = Schema.decodeUnknownSync(IntentFactBasis, {
          onExcessProperty: "error",
        })({
          kind: "authorial-intent",
          generation: authority.generation,
          contentSha256: authority.intentSha256,
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
        for (const node of doc.nodes) {
          const sink = { canvasName: name, nodeId: node.id };
          for (const message of node.ether?.messages?.items ?? []) {
            yield* workRepository.appendMessage({
              sink,
              basis,
              message,
              sentBy: adjacentActor(node.id),
              destination: { kind: "mailbox" },
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
        delete process.env.JUNTO_CANVASES_DIR;
      } else {
        process.env.JUNTO_CANVASES_DIR = previousCanvasesDir;
      }
    }
  }
};

/**
 * Remove canvases from an explicit database, keeping only the seeded names.
 * Demo-mode apps mint an ephemeral product database and create an empty
 * default canvas at first boot; launchJunto removes it so the renderer
 * boots onto the seeded canvas instead of the empty default.
 */
export const removeFixtureCanvases = async (
  sandbox: Sandbox,
  databasePath: string,
  keep: ReadonlySet<string>,
): Promise<void> => {
  const previousCanvasesDir = process.env.JUNTO_CANVASES_DIR;
  process.env.JUNTO_CANVASES_DIR = sandbox.canvasesDir;
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
        delete process.env.JUNTO_CANVASES_DIR;
      } else {
        process.env.JUNTO_CANVASES_DIR = previousCanvasesDir;
      }
    }
  }
};

/**
 * Seed a usage-plane last-good state into the same explicit SQLite database
 * Electron opens. This is the product's durable seam (`usage_state` row):
 * UsageCache paints it at boot and UsageService keeps it when a live poll
 * fails, so scenarios drive the native HUD without touching any source.
 */
export const writeFixtureUsageState = async (
  sandbox: Sandbox,
  state: UsageState,
  databasePath?: string,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    makeStateEngineLive(
      databasePath ??
        join(sandbox.homeDir, ".junto", "state", "junto.db"),
    ),
  );
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(
      sql`INSERT INTO usage_state(singleton, snapshots_json, last_live_at, updated_at)
         VALUES (1, ${JSON.stringify(state.snapshots)}, ${state.lastLiveAt ?? new Date().toISOString()}, ${new Date().toISOString()})
         ON CONFLICT(singleton) DO UPDATE SET
           snapshots_json = excluded.snapshots_json,
           last_live_at = excluded.last_live_at,
           updated_at = excluded.updated_at`,
    ));
  } finally {
    await runtime.dispose();
  }
};

/** Seed enrolled hosts into the same explicit SQLite database Electron opens. */
export const writeFixtureHosts = async (
  sandbox: Sandbox,
  hosts: ReadonlyArray<RemoteHost>,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    HostsPersistenceLive.pipe(Layer.provide(
      makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")),
    )),
  );
  try {
    const persistence = await runtime.runPromise(HostsPersistence);
    const registry = makeHostsRegistry(persistence, (e) => runtime.runPromise(e));
    for (const host of hosts) {
      await registry.upsert(host);
    }
  } finally {
    await runtime.dispose();
  }
};

/** Agent signals seeded as durable rows, as if their seats had raised them. */
export const writeFixtureAgentSignals = async (
  sandbox: Sandbox,
  signals: ReadonlyArray<AgentSignal>,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")),
  );
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      for (const signal of signals) {
        yield* sql`INSERT INTO agent_signals(
             signal_id, canvas_name, node_id, kind, text, detail, created_at,
             state, response_text, response_at, closed_at)
           VALUES (${signal.signalId}, ${signal.canvasName}, ${signal.nodeId}, ${signal.kind},
             ${signal.text}, ${signal.detail ?? null}, ${signal.createdAt}, ${signal.state},
             ${signal.response?.text ?? null}, ${signal.response?.at ?? null}, ${signal.closedAt ?? null})`;
      }
    })));
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

/** Junto-owned native terminal node (entity.kind terminal + ether.terminal).
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


/** A managed agent seat for scripted scenarios.
 * `key` is the process-bind agent key (`<host>:<profile>`); the same stable
 * key is its fixture binding identity.
 *
 * The seat carries the document launch the authoring path writes (template
 * argv plus a chosen folder). Main refuses a managed agent seat with no
 * working directory — its cwd would otherwise fall back to the operator home —
 * so a fixture seat that omitted one could never spawn. The default folder is
 * the temp root: it always exists and is never the sandbox home. */
export const agentTextNode = (input: {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly host?: string;
  readonly harness?: import("../../src/shared/managed-terminal-templates").HarnessId;
  readonly cwd?: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => {
  const harness = input.harness ?? "codex";
  const cwd = input.cwd ?? tmpdir();
  const launch = resolveManagedLaunch(
    harness,
    { cwd, injection: { seatBound: false, connected: false } },
    {},
  );
  return {
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
        harness,
        launch: { ...launch, cwd },
      },
    },
  };
};

export const canvasDoc = (
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[] = [],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

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

// --- edge fixtures -----------------------------------------------------------

/**
 * Where `verbEdge` reads endpoint kinds from: the fixture's own node list, or
 * an explicit node id -> kind map when the nodes are not assembled yet.
 * A node absent from either has no kind, which is exactly what geography is.
 */
export type EdgeKindSource =
  | ReadonlyArray<CanvasNode>
  | Readonly<Record<string, string | undefined>>;

const kindOfNodeId = (
  kinds: EdgeKindSource,
  nodeId: string,
): string | undefined => {
  if (Array.isArray(kinds)) {
    const node = (kinds as ReadonlyArray<CanvasNode>).find(
      (candidate) => candidate.id === nodeId,
    );
    if (node === undefined) {
      throw new Error(
        `verbEdge: node ${JSON.stringify(nodeId)} is not in the fixture's node list`,
      );
    }
    return node.ether?.entity?.kind;
  }
  return (kinds as Readonly<Record<string, string | undefined>>)[nodeId];
};

/**
 * The one authored fact on an edge, checked against the grammar at
 * fixture-build time.
 *
 * A verb its ordered pair does not admit is dropped by `scrubCanvasDocInput`
 * on decode — the fixture silently loses the wire and the spec goes on
 * asserting against a graph that never existed. Throwing here turns that
 * silence into a build-time failure with the legal verbs in the message.
 *
 * Geography (plain text nodes, terminal) admits no verb at all, so any wire
 * touching it fails loudly rather than vanishing.
 */
export const verbEdge = (
  id: string,
  fromNode: string,
  toNode: string,
  verb: Verb,
  kinds: EdgeKindSource,
  sides?: {
    readonly fromSide?: NodeSide;
    readonly toSide?: NodeSide;
  },
): CanvasEdge => {
  const fromKind = kindOfNodeId(kinds, fromNode);
  const toKind = kindOfNodeId(kinds, toNode);
  const legal = verbsForPair(fromKind, toKind);
  if (!legal.includes(verb)) {
    throw new Error(
      `verbEdge ${JSON.stringify(id)}: ${fromKind ?? "geography"} -> ${toKind ?? "geography"} ` +
        `does not admit ${JSON.stringify(verb)}; legal verbs: ` +
        `${legal.length > 0 ? legal.join(", ") : "(none — this pair cannot be wired)"}`,
    );
  }
  return {
    id,
    fromNode,
    toNode,
    fromSide: sides?.fromSide ?? "right",
    toSide: sides?.toSide ?? "left",
    ether: { verb },
  };
};
