import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  workTaskClaim,
  workTaskCreate,
  workTaskDescribe,
  type WorkIds,
} from "../src/shared/work";
import {
  COMMAND_CENTER_WORK_HOME,
  WorkRepository,
  WorkRepositoryLive,
  stationEventFromWorkEvent,
} from "../src/main/vellum/work/repository";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";
import {
  InstallationId,
  ConfigureRequest,
  PairRequest,
  STATION_API_PROTOCOL,
  StationHostId,
  type InstallationId as InstallationIdValue,
  type StationEvent,
} from "../src/shared/station-api";
import {
  StationRepository,
  StationRepositoryLive,
} from "../src/main/vellum/station/repository";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

const runtimeAt = (path: string) =>
  ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(path),
    ),
  );

const runtime = () => {
  const root = join(tmpdir(), `vellum-work-replication-${randomUUID()}`);
  roots.push(root);
  return runtimeAt(join(root, "vellum.db"));
};

const serviceRuntime = () => {
  const root = join(tmpdir(), `vellum-work-service-replication-${randomUUID()}`);
  roots.push(root);
  const state = makeStateEngineLive(join(root, "vellum.db"));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(WorkRepositoryLive, StationRepositoryLive),
    state,
  );
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  return ManagedRuntime.make(Layer.provideMerge(WorkLive, canvases));
};

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const stationHost = (value: string) =>
  Schema.decodeUnknownSync(StationHostId)(value);

const ids = (prefix: string): WorkIds => {
  let task = 0;
  let message = 0;
  return {
    id: () => `${prefix}-task-${++task}`,
    messageId: () => `${prefix}-message-${++message}`,
  };
};

const taskCanvas = (nodeId: string, host: string): CanvasDoc => ({
  nodes: [{
    id: nodeId,
    type: "text",
    text: "station task sink",
    x: 0,
    y: 0,
    width: 220,
    height: 100,
    ether: {
      entity: { kind: "task" },
      host,
    },
  }],
  edges: [],
});

const intermediateWorkSchema = (
  includeReceipt: boolean,
  includePartialPending: boolean,
): string => `
  CREATE TABLE work_event_sequences (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    last_seq TEXT NOT NULL,
    PRIMARY KEY (event_home, entity_home)
  );
  CREATE TABLE work_events (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    canvas_name TEXT NOT NULL,
    node_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL CHECK (
      entity_kind IN (
        'task',
        'request',
        'message',
        'artifact'
        ${includeReceipt ? ", 'receipt'" : ""}
      )
    ),
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    origin_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    PRIMARY KEY (event_home, entity_home, seq)
  );
  INSERT INTO work_event_sequences VALUES ('cc-intermediate', 'studio', '1');
  INSERT INTO work_events VALUES (
    'cc-intermediate',
    'studio',
    '1',
    'obsolete',
    'sink',
    'task',
    'task-1',
    'task.create',
    'obsolete',
    'obsolete',
    '{}',
    '${"a".repeat(64)}'
  );
  CREATE TABLE station_received_cursors (
    home TEXT PRIMARY KEY,
    through_sequence TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE station_peer_ack_cursors (
    peer_installation_id TEXT NOT NULL,
    home TEXT NOT NULL,
    through_sequence TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL,
    PRIMARY KEY (peer_installation_id, home)
  );
  INSERT INTO station_received_cursors
    VALUES ('stale-remote', '42', 'obsolete');
  INSERT INTO station_peer_ack_cursors
    VALUES ('stale-remote', 'cc-intermediate', '37', 'obsolete');
  ${
    includePartialPending
      ? `
        CREATE TABLE work_pending_commands (
          event_home TEXT NOT NULL,
          entity_home TEXT NOT NULL,
          seq TEXT NOT NULL,
          status TEXT NOT NULL,
          acknowledged_by TEXT,
          resolved_at TEXT,
          PRIMARY KEY (event_home, entity_home, seq)
        );
      `
      : ""
  }
`;

const createTask = (
  repository: typeof WorkRepository.Service,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly eventHome: InstallationIdValue;
    readonly brief: string;
    readonly ids: WorkIds;
    readonly materialization: "immediate" | "on-disposition";
  },
) =>
  repository.mutate({
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityHome: input.entityHome,
    eventHome: input.eventHome,
    materialization: input.materialization,
    operation: "task.create",
    authoredDoc: taskCanvas(input.nodeId, input.entityHome),
    transform: (projected) => {
      const result = workTaskCreate(
        projected,
        input.canvasName,
        input.nodeId,
        input.brief,
        undefined,
        input.ids,
      );
      return { doc: result.doc, value: result.task };
    },
  });

const events = (
  repository: typeof WorkRepository.Service,
  eventHome: InstallationIdValue,
  entityHome: string,
  afterSeq = "0",
) =>
  repository.eventsAfter({ eventHome, entityHome, afterSeq }).pipe(
    Effect.map((items) => items.map(stationEventFromWorkEvent)),
  );

const acceptCommands = (
  repository: typeof WorkRepository.Service,
  input: {
    readonly local: InstallationIdValue;
    readonly commandCenter: InstallationIdValue;
    readonly route: string;
    readonly events: ReadonlyArray<StationEvent>;
  },
) =>
  repository.acceptReplicated({
    localEventHome: input.local,
    eventHome: input.commandCenter,
    entityHome: input.route,
    events: input.events,
    causalConflict: "reject-command",
  });

const acceptRemoteFacts = (
  repository: typeof WorkRepository.Service,
  input: {
    readonly local: InstallationIdValue;
    readonly remote: InstallationIdValue;
    readonly route: string;
    readonly events: ReadonlyArray<StationEvent>;
  },
) =>
  repository.acceptReplicated({
    localEventHome: input.local,
    eventHome: input.remote,
    entityHome: input.route,
    events: input.events,
    causalConflict: "fail",
  });

describe("WorkRepository station replication", () => {
  it("irreversibly replaces obsolete work and generic Station event stores on reopen", async () => {
    const root = join(
      tmpdir(),
      `vellum-work-cutover-${randomUUID()}`,
    );
    roots.push(root);
    await mkdir(root, { recursive: true });
    const path = join(root, "vellum.db");
    const obsolete = new DatabaseSync(path);
    try {
      obsolete.exec(`
        CREATE TABLE work_home_sequences (
          home_station TEXT PRIMARY KEY,
          last_seq TEXT NOT NULL
        );
        CREATE TABLE work_events (
          home_station TEXT NOT NULL,
          seq TEXT NOT NULL,
          PRIMARY KEY (home_station, seq)
        );
        CREATE TABLE work_tasks (
          canvas_name TEXT NOT NULL,
          node_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          PRIMARY KEY (canvas_name, node_id, task_id)
        );
        INSERT INTO work_home_sequences VALUES ('obsolete', '1');
        INSERT INTO work_events VALUES ('obsolete', '1');
        INSERT INTO work_tasks VALUES ('old', 'sink', 'discarded');

        CREATE TABLE station_outbound_sequences (
          home TEXT PRIMARY KEY,
          last_sequence TEXT NOT NULL
        );
        CREATE TABLE station_events (
          home TEXT NOT NULL,
          sequence TEXT NOT NULL,
          direction TEXT NOT NULL,
          PRIMARY KEY (home, sequence)
        );
        CREATE INDEX station_events_home_order
          ON station_events(home, length(sequence), sequence);
        CREATE INDEX station_events_direction_home_order
          ON station_events(
            direction,
            home,
            length(sequence),
            sequence
          );
        CREATE TABLE station_received_cursors (
          home TEXT PRIMARY KEY,
          through_sequence TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE station_peer_ack_cursors (
          peer_installation_id TEXT NOT NULL,
          home TEXT NOT NULL,
          through_sequence TEXT NOT NULL,
          acknowledged_at TEXT NOT NULL,
          PRIMARY KEY (peer_installation_id, home)
        );
        INSERT INTO station_received_cursors
          VALUES ('obsolete-peer', '99', 'obsolete');
        INSERT INTO station_peer_ack_cursors
          VALUES ('obsolete-peer', 'obsolete-local', '77', 'obsolete');
      `);
    } finally {
      obsolete.close();
    }

    const first = runtimeAt(path);
    const repository = await first.runPromise(WorkRepository);
    const cc = installation("cc-cutover");
    const schema = await first.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.work-cutover", (reader) => ({
          retired: reader.all<{ readonly name: string }>(
            `
                SELECT name
                FROM sqlite_schema
                WHERE name IN (
                  'work_home_sequences',
                  'station_outbound_sequences',
                  'station_events',
                  'station_events_home_order',
                  'station_events_direction_home_order'
                )
            `,
          ),
          eventColumns: reader
            .all<{ readonly name: string }>(
              "SELECT name FROM pragma_table_info('work_events')",
            )
            .map((row) => row.name),
          receivedCursors: reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM station_received_cursors",
          )?.count,
          peerCursors: reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM station_peer_ack_cursors",
          )?.count,
        }))
      ),
    );
    expect(schema.retired).toEqual([]);
    expect(schema.eventColumns).toEqual(
      expect.arrayContaining(["event_home", "entity_home", "seq"]),
    );
    expect(schema.receivedCursors).toBe(0);
    expect(schema.peerCursors).toBe(0);

    await first.runPromise(
      createTask(repository, {
        canvasName: "factory",
        nodeId: "local-tasks",
        entityHome: "local",
        eventHome: cc,
        brief: "current row survives reopen",
        ids: ids("cutover"),
        materialization: "immediate",
      }),
    );
    await first.dispose();

    const reopened = runtimeAt(path);
    const reopenedRepository = await reopened.runPromise(WorkRepository);
    expect(
      (await reopened.runPromise(
        reopenedRepository.readSnapshot("factory", "local-tasks"),
      )).tasks.items[0]?.history[0]?.parts[0],
    ).toEqual({ kind: "text", text: "current row survives reopen" });
    await reopened.dispose();
  });

  it.each([
    ["4fe event log", false, false],
    ["partially upgraded receipt log", true, true],
  ])("resets the %s to the one current work schema", async (
    _label,
    includeReceipt,
    includePartialPending,
  ) => {
    const root = join(
      tmpdir(),
      `vellum-work-intermediate-${randomUUID()}`,
    );
    roots.push(root);
    await mkdir(root, { recursive: true });
    const path = join(root, "vellum.db");
    const obsolete = new DatabaseSync(path);
    try {
      obsolete.exec(
        intermediateWorkSchema(
          includeReceipt,
          includePartialPending,
        ),
      );
    } finally {
      obsolete.close();
    }

    const first = runtimeAt(path);
    const firstState = await first.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.intermediate-cutover", (reader) => ({
          events: reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM work_events",
          )?.count,
          pendingSql: reader.get<{ readonly sql: string }>(
            `
              SELECT sql
              FROM sqlite_schema
              WHERE type = 'table' AND name = 'work_pending_commands'
            `,
          )?.sql,
          rejectionColumns: reader
            .all<{ readonly name: string }>(
              "SELECT name FROM pragma_table_info('work_rejections')",
            )
            .map((row) => row.name),
          receivedCursors: reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM station_received_cursors",
          )?.count,
          peerCursors: reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM station_peer_ack_cursors",
          )?.count,
        }))
      ),
    );
    expect(firstState.events).toBe(0);
    expect(firstState.pendingSql).toContain("'applied'");
    expect(firstState.pendingSql).toContain("'rejected'");
    expect(firstState.rejectionColumns).toContain("reported_by");
    expect(firstState.receivedCursors).toBe(0);
    expect(firstState.peerCursors).toBe(0);
    await first.dispose();

    const reopened = runtimeAt(path);
    const reopenedState = await reopened.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.intermediate-reopen", (reader) => ({
          events: reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM work_events",
          )?.count,
          pending: reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM work_pending_commands",
          )?.count,
        }))
      ),
    );
    expect(reopenedState).toEqual({ events: 0, pending: 0 });
    await reopened.dispose();
  });

  it("rejects a route sequence gap without materializing or advancing its ACK", async () => {
    const commandCenter = runtime();
    const remote = runtime();
    const source = await commandCenter.runPromise(WorkRepository);
    const target = await remote.runPromise(WorkRepository);
    const cc = installation("cc-gap");
    const station = installation("station-gap");

    await commandCenter.runPromise(
      createTask(source, {
        canvasName: "factory",
        nodeId: "remote-tasks",
        entityHome: "studio",
        eventHome: cc,
        brief: "first routed command",
        ids: ids("gap"),
        materialization: "on-disposition",
      }),
    );
    const [first] = await commandCenter.runPromise(
      events(source, cc, "studio"),
    );
    const gap = await remote.runPromise(
      acceptCommands(target, {
        local: station,
        commandCenter: cc,
        route: "studio",
        events: [{
          ...first!,
          identity: { ...first!.identity, sequence: "2" as never },
        }],
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(gap)).toBe(true);
    if (Either.isLeft(gap)) {
      expect(gap.left).toMatchObject({
        _tag: "WorkReplicationError",
        reason: "sequence-gap",
      });
    }
    expect(
      (await remote.runPromise(
        target.readSnapshot("factory", "remote-tasks"),
      )).tasks.items,
    ).toEqual([]);

    const accepted = await remote.runPromise(
      acceptCommands(target, {
        local: station,
        commandCenter: cc,
        route: "studio",
        events: [first!],
      }),
    );
    expect(accepted.acknowledgement.through).toBe("1");

    await commandCenter.dispose();
    await remote.dispose();
  });

  it("keeps a Remote command pending on CC until the ordered applied disposition returns", async () => {
    const commandCenter = runtime();
    const remote = runtime();
    const ccRepository = await commandCenter.runPromise(WorkRepository);
    const remoteRepository = await remote.runPromise(WorkRepository);
    const cc = installation("cc-accepted");
    const station = installation("station-accepted");

    const queued = await commandCenter.runPromise(
      createTask(ccRepository, {
        canvasName: "factory",
        nodeId: "remote-tasks",
        entityHome: "studio",
        eventHome: cc,
        brief: "render the release",
        ids: ids("accepted"),
        materialization: "on-disposition",
      }),
    );
    expect(queued.disposition).toBe("queued");
    expect(
      await commandCenter.runPromise(ccRepository.commandStatus),
    ).toMatchObject({
      counts: { pending: 1, applied: 0, rejected: 0 },
      pending: [{
        command: { eventHome: cc, entityHome: "studio", seq: "1" },
        canvasName: "factory",
        nodeId: "remote-tasks",
        entityKind: "task",
        operation: "task.create",
      }],
      rejections: [],
      truncated: { pending: false, rejections: false },
    });
    expect(
      (await commandCenter.runPromise(
        ccRepository.readSnapshot("factory", "remote-tasks"),
      )).tasks.items,
    ).toEqual([]);

    const commands = await commandCenter.runPromise(
      events(ccRepository, cc, "studio"),
    );
    const commandReceipt = await remote.runPromise(
      acceptCommands(remoteRepository, {
        local: station,
        commandCenter: cc,
        route: "studio",
        events: commands,
      }),
    );
    expect(commandReceipt).toMatchObject({
      accepted: 1,
      rejected: 0,
      acknowledgement: { home: cc, through: "1" },
    });
    expect(
      (await remote.runPromise(
        remoteRepository.readSnapshot("factory", "remote-tasks"),
      )).tasks.items[0]?.history[0]?.parts[0],
    ).toEqual({ kind: "text", text: "render the release" });

    const dispositions = await remote.runPromise(
      events(remoteRepository, station, "studio"),
    );
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]?.body).toContain(
      '"disposition":"applied"',
    );
    await commandCenter.runPromise(
      acceptRemoteFacts(ccRepository, {
        local: cc,
        remote: station,
        route: "studio",
        events: dispositions,
      }),
    );
    expect(
      await commandCenter.runPromise(ccRepository.commandStatus),
    ).toMatchObject({
      counts: { pending: 0, applied: 1, rejected: 0 },
      pending: [],
      rejections: [],
    });
    expect(
      (await commandCenter.runPromise(
        ccRepository.readSnapshot("factory", "remote-tasks"),
      )).tasks.items[0]?.history[0]?.parts[0],
    ).toEqual({ kind: "text", text: "render the release" });

    const retry = await remote.runPromise(
      acceptCommands(remoteRepository, {
        local: station,
        commandCenter: cc,
        route: "studio",
        events: commands,
      }),
    );
    expect(retry).toMatchObject({
      accepted: 0,
      idempotent: 1,
      rejected: 0,
      acknowledgement: { home: cc, through: "1" },
    });
    expect(
      await remote.runPromise(events(remoteRepository, station, "studio")),
    ).toHaveLength(1);

    await commandCenter.dispose();
    await remote.dispose();
  });

  it("fails closed before role selection, then queues and converges after explicit CC/Remote configuration", async () => {
    const commandCenter = serviceRuntime();
    const remote = serviceRuntime();
    const ccWork = await commandCenter.runPromise(WorkService);
    const ccCanvases = await commandCenter.runPromise(CanvasesService);
    const ccRepository = await commandCenter.runPromise(WorkRepository);
    const ccStations = await commandCenter.runPromise(StationRepository);
    const remoteWork = await remote.runPromise(WorkService);
    const remoteRepository = await remote.runPromise(WorkRepository);
    const remoteStations = await remote.runPromise(StationRepository);
    const cc = await commandCenter.runPromise(ccStations.installationId);
    const station = await remote.runPromise(remoteStations.installationId);
    const canvas = "explicit-topology";
    const node = "studio-tasks";
    const route = "studio";

    await commandCenter.runPromise(
      ccCanvases.write(canvas, taskCanvas(node, route)),
    );
    const unset = await commandCenter.runPromise(
      ccWork.workTaskCreate(canvas, node, "must not infer a role"),
    );
    const denied = [
      unset,
      await commandCenter.runPromise(
        ccWork.workTaskDescribe(canvas, node, "task", "brief"),
      ),
      await commandCenter.runPromise(
        ccWork.workTaskTransition(canvas, node, "task", "working"),
      ),
      await commandCenter.runPromise(
        ccWork.workTaskClaim(canvas, node, "task", "actor"),
      ),
      await commandCenter.runPromise(
        ccWork.workMessageAppend(canvas, node, null, {
          messageId: "message",
          role: "user",
          parts: [{ kind: "text", text: "message" }],
        }),
      ),
      await commandCenter.runPromise(
        ccWork.workRequestCreate(canvas, node, "request"),
      ),
      await commandCenter.runPromise(
        ccWork.workRequestResolve(
          canvas,
          node,
          "request",
          "response",
          "completed",
        ),
      ),
      await commandCenter.runPromise(
        ccWork.workArtifactPublish(canvas, node, {
          artifactId: "artifact",
          parts: [{ kind: "text", text: "artifact" }],
        }),
      ),
    ];
    expect(denied).toHaveLength(8);
    for (const result of denied) {
      expect(result).toMatchObject({
        ok: false,
        code: "invalid",
        message: expect.stringContaining("station role is not configured"),
      });
    }
    expect(
      await commandCenter.runPromise(events(ccRepository, cc, route)),
    ).toEqual([]);
    expect(
      await commandCenter.runPromise(ccRepository.commandStatus),
    ).toMatchObject({
      counts: { pending: 0, applied: 0, rejected: 0 },
    });

    await commandCenter.runPromise(
      ccStations.configure(
        ConfigureRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "configure",
          installationId: cc,
          configuration: {
            role: "command-center",
            hostId: stationHost("command"),
            supervisedPreferred: true,
          },
        }),
      ),
    );
    await remote.runPromise(
      remoteStations.pair(
        PairRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "pair",
          commandCenterInstallationId: cc,
          stationInstallationId: station,
          stationLabel: "Studio",
          appVersion: "test",
        }),
      ),
    );
    await remote.runPromise(
      remoteStations.configure(
        ConfigureRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "configure",
          installationId: station,
          configuration: {
            role: "remote",
            hostId: stationHost(route),
            agentHostId: stationHost(route),
            commandCenterInstallationId: cc,
            commandCenterRef: "cc.tailnet",
            supervisedPreferred: true,
          },
        }),
      ),
    );
    const remoteInbox = await remote.runPromise(
      remoteWork.workMessageAppend("remote-inbox", "agent", null, {
        messageId: "remote-inbox-message",
        role: "user",
        parts: [{ kind: "text", text: "must stay on Command Center" }],
      }),
    );
    expect(remoteInbox).toMatchObject({
      ok: false,
      code: "invalid",
      message: expect.stringContaining(
        "messages are Command-Center-homed",
      ),
    });
    expect(
      await remote.runPromise(
        events(
          remoteRepository,
          station,
          COMMAND_CENTER_WORK_HOME,
        ),
      ),
    ).toEqual([]);
    expect(
      (await remote.runPromise(
        remoteRepository.readSnapshot("remote-inbox", "agent"),
      )).messages.items,
    ).toEqual([]);

    const queued = await commandCenter.runPromise(
      ccWork.workTaskCreate(canvas, node, "explicitly routed"),
    );
    expect(queued).toMatchObject({
      ok: true,
      disposition: "queued",
    });
    const commands = await commandCenter.runPromise(
      events(ccRepository, cc, route),
    );
    expect(commands).toHaveLength(1);
    await remote.runPromise(
      acceptCommands(remoteRepository, {
        local: station,
        commandCenter: cc,
        route,
        events: commands,
      }),
    );
    const dispositions = await remote.runPromise(
      events(remoteRepository, station, route),
    );
    await commandCenter.runPromise(
      acceptRemoteFacts(ccRepository, {
        local: cc,
        remote: station,
        route,
        events: dispositions,
      }),
    );

    expect(
      (await commandCenter.runPromise(
        ccRepository.readSnapshot(canvas, node),
      )).tasks.items[0]?.history[0]?.parts[0],
    ).toEqual({ kind: "text", text: "explicitly routed" });
    expect(
      await commandCenter.runPromise(ccRepository.commandStatus),
    ).toMatchObject({
      counts: { pending: 0, applied: 1, rejected: 0 },
    });

    await commandCenter.dispose();
    await remote.dispose();
  });

  it("converges an offline Remote branch through rejection and accepts the next reconciled command", async () => {
    const commandCenter = runtime();
    const remote = runtime();
    const ccRepository = await commandCenter.runPromise(WorkRepository);
    const remoteRepository = await remote.runPromise(WorkRepository);
    const cc = installation("cc-concurrent");
    const station = installation("station-concurrent");
    const route = "studio";
    const node = "remote-tasks";
    const canvas = "factory";
    const sourceIds = ids("cc");
    const remoteIds = ids("remote");
    const authoredDoc = taskCanvas(node, route);

    const created = await commandCenter.runPromise(
      createTask(ccRepository, {
        canvasName: canvas,
        nodeId: node,
        entityHome: route,
        eventHome: cc,
        brief: "initial brief",
        ids: sourceIds,
        materialization: "on-disposition",
      }),
    );
    const createCommands = await commandCenter.runPromise(
      events(ccRepository, cc, route),
    );
    await remote.runPromise(
      acceptCommands(remoteRepository, {
        local: station,
        commandCenter: cc,
        route,
        events: createCommands,
      }),
    );
    const initialDisposition = await remote.runPromise(
      events(remoteRepository, station, route),
    );
    await commandCenter.runPromise(
      acceptRemoteFacts(ccRepository, {
        local: cc,
        remote: station,
        route,
        events: initialDisposition,
      }),
    );

    await remote.runPromise(
      remoteRepository.mutate({
        canvasName: canvas,
        nodeId: node,
        entityHome: route,
        eventHome: station,
        materialization: "immediate",
        operation: "task.claim",
        authoredDoc,
        transform: (projected) => {
          const result = workTaskClaim(
            projected,
            canvas,
            node,
            created.value.id,
            "agent-studio",
            remoteIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    await commandCenter.runPromise(
      ccRepository.mutate({
        canvasName: canvas,
        nodeId: node,
        entityHome: route,
        eventHome: cc,
        materialization: "on-disposition",
        operation: "task.describe",
        authoredDoc,
        transform: (projected) => {
          const result = workTaskDescribe(
            projected,
            canvas,
            node,
            created.value.id,
            "stale Command Center edit",
            sourceIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    expect(
      await commandCenter.runPromise(ccRepository.commandStatus),
    ).toMatchObject({
      counts: { pending: 1, applied: 1, rejected: 0 },
      pending: [{
        command: { eventHome: cc, entityHome: route, seq: "2" },
        operation: "task.describe",
      }],
    });
    const duplicatePending = await commandCenter.runPromise(
      ccRepository.mutate({
        canvasName: canvas,
        nodeId: node,
        entityHome: route,
        eventHome: cc,
        materialization: "on-disposition",
        operation: "task.describe",
        authoredDoc,
        transform: (projected) => {
          const result = workTaskDescribe(
            projected,
            canvas,
            node,
            created.value.id,
            "second speculative edit",
            sourceIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(duplicatePending)).toBe(true);
    if (Either.isLeft(duplicatePending)) {
      expect(duplicatePending.left).toMatchObject({
        code: "invalid",
      });
      expect(duplicatePending.left.message).toContain(
        "already has a pending Remote command",
      );
    }
    const [staleCommand] = await commandCenter.runPromise(
      events(ccRepository, cc, route, "1"),
    );

    const rejected = await remote.runPromise(
      acceptCommands(remoteRepository, {
        local: station,
        commandCenter: cc,
        route,
        events: [staleCommand!],
      }),
    );
    expect(rejected).toMatchObject({
      accepted: 0,
      rejected: 1,
      acknowledgement: { home: cc, through: "2" },
    });
    expect(
      await remote.runPromise(remoteRepository.commandStatus),
    ).toMatchObject({
      counts: { pending: 0, applied: 0, rejected: 0 },
      pending: [],
      rejections: [],
      truncated: { pending: false, rejections: false },
    });

    const orderedRemoteFacts = await remote.runPromise(
      events(remoteRepository, station, route, "1"),
    );
    expect(orderedRemoteFacts).toHaveLength(2);
    expect(orderedRemoteFacts[0]?.body).toContain('"operation":"task.claim"');
    expect(orderedRemoteFacts[1]?.body).toContain(
      '"disposition":"rejected"',
    );
    await commandCenter.runPromise(
      acceptRemoteFacts(ccRepository, {
        local: cc,
        remote: station,
        route,
        events: orderedRemoteFacts,
      }),
    );

    const converged = await commandCenter.runPromise(
      ccRepository.readSnapshot(canvas, node),
    );
    expect(converged.tasks.items[0]).toMatchObject({
      state: "working",
      metadata: { claimedBy: "agent-studio" },
    });
    expect(converged.tasks.items[0]?.history[0]?.parts[0]).toEqual({
      kind: "text",
      text: "initial brief",
    });
    expect(
      await commandCenter.runPromise(
        ccRepository.rejectionsForRoute(route),
      ),
    ).toMatchObject([{
      rejected: { eventHome: cc, entityHome: route, seq: "2" },
      reportedBy: station,
      reason: "causal-conflict",
    }]);
    expect(
      await commandCenter.runPromise(ccRepository.commandStatus),
    ).toMatchObject({
      counts: { pending: 0, applied: 1, rejected: 1 },
      pending: [],
      rejections: [{
        rejected: { eventHome: cc, entityHome: route, seq: "2" },
        reportedBy: station,
        reason: "causal-conflict",
      }],
      truncated: { pending: false, rejections: false },
    });

    const retry = await remote.runPromise(
      acceptCommands(remoteRepository, {
        local: station,
        commandCenter: cc,
        route,
        events: [staleCommand!],
      }),
    );
    expect(retry).toMatchObject({
      accepted: 0,
      idempotent: 1,
      rejected: 0,
      acknowledgement: { home: cc, through: "2" },
    });

    await commandCenter.runPromise(
      ccRepository.mutate({
        canvasName: canvas,
        nodeId: node,
        entityHome: route,
        eventHome: cc,
        materialization: "on-disposition",
        operation: "task.describe",
        authoredDoc,
        transform: (projected) => {
          const result = workTaskDescribe(
            projected,
            canvas,
            node,
            created.value.id,
            "reconciled Command Center edit",
            sourceIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    const [nextCommand] = await commandCenter.runPromise(
      events(ccRepository, cc, route, "2"),
    );
    await remote.runPromise(
      acceptCommands(remoteRepository, {
        local: station,
        commandCenter: cc,
        route,
        events: [nextCommand!],
      }),
    );
    const [appliedDisposition] = await remote.runPromise(
      events(remoteRepository, station, route, "3"),
    );
    await commandCenter.runPromise(
      acceptRemoteFacts(ccRepository, {
        local: cc,
        remote: station,
        route,
        events: [appliedDisposition!],
      }),
    );

    const ccFinal = await commandCenter.runPromise(
      ccRepository.readSnapshot(canvas, node),
    );
    const remoteFinal = await remote.runPromise(
      remoteRepository.readSnapshot(canvas, node),
    );
    expect(ccFinal.tasks.items).toEqual(remoteFinal.tasks.items);
    expect(ccFinal.tasks.items[0]?.history[0]?.parts[0]).toEqual({
      kind: "text",
      text: "reconciled Command Center edit",
    });

    await commandCenter.dispose();
    await remote.dispose();
  });

  it("isolates two Remote routes that each originate sequence one", async () => {
    const commandCenter = runtime();
    const remoteA = runtime();
    const remoteB = runtime();
    const ccRepository = await commandCenter.runPromise(WorkRepository);
    const cc = installation("cc-routes");
    const routes = [
      {
        runtime: remoteA,
        repository: await remoteA.runPromise(WorkRepository),
        host: "host-a",
        node: "tasks-a",
        station: installation("station-a"),
      },
      {
        runtime: remoteB,
        repository: await remoteB.runPromise(WorkRepository),
        host: "host-b",
        node: "tasks-b",
        station: installation("station-b"),
      },
    ] as const;

    for (const route of routes) {
      await commandCenter.runPromise(
        createTask(ccRepository, {
          canvasName: "factory",
          nodeId: route.node,
          entityHome: route.host,
          eventHome: cc,
          brief: `work for ${route.host}`,
          ids: ids(route.host),
          materialization: "on-disposition",
        }),
      );
      const commands = await commandCenter.runPromise(
        events(ccRepository, cc, route.host),
      );
      expect(commands[0]?.identity.sequence).toBe("1");
      await route.runtime.runPromise(
        acceptCommands(route.repository, {
          local: route.station,
          commandCenter: cc,
          route: route.host,
          events: commands,
        }),
      );
      const dispositions = await route.runtime.runPromise(
        events(route.repository, route.station, route.host),
      );
      expect(dispositions[0]?.identity.sequence).toBe("1");
      await commandCenter.runPromise(
        acceptRemoteFacts(ccRepository, {
          local: cc,
          remote: route.station,
          route: route.host,
          events: dispositions,
        }),
      );
    }

    expect(
      (await commandCenter.runPromise(
        ccRepository.readSnapshot("factory", "tasks-a"),
      )).tasks.items[0]?.history[0]?.parts[0],
    ).toEqual({ kind: "text", text: "work for host-a" });
    expect(
      (await commandCenter.runPromise(
        ccRepository.readSnapshot("factory", "tasks-b"),
      )).tasks.items[0]?.history[0]?.parts[0],
    ).toEqual({ kind: "text", text: "work for host-b" });

    await commandCenter.dispose();
    await remoteA.dispose();
    await remoteB.dispose();
  });
});
