import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  ConfigureRequest,
  InstallationId,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  ReportRequest,
  STATION_API_PROTOCOL,
  StationHostId,
  StatusRequest,
  type InstallationId as InstallationIdValue,
} from "../src/shared/station-api";
import {
  decodeStationControlEnvelope,
  type StationControlEnvelope,
} from "../src/shared/station-control";
import {
  StationRepository,
  makeStationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  StationApiLive,
  StationApiService,
} from "../src/main/vellum/station/api";
import {
  startStationControlServer,
  type StationControlServer,
} from "../src/main/vellum/station/control-server";
import {
  sendStationControlRequest,
} from "../src/main/vellum/station/control-client";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { Either } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { workTaskClaim, workTaskCreate } from "../src/shared/work";
import {
  WorkRepository,
  WorkRepositoryLive,
  stationEventFromWorkEvent,
} from "../src/main/vellum/work/repository";
import { compileStationPortfolioBody } from "../src/main/vellum/station/portfolio";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeHostId = Schema.decodeUnknownSync(StationHostId);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);

type TestRuntime = ReturnType<typeof makeRuntime>;

const roots: string[] = [];
const servers: StationControlServer[] = [];
const runtimes: TestRuntime[] = [];

const LOCAL = decodeInstallationId("station-studio");
const COMMAND_CENTER = decodeInstallationId("command-center");
const NOW = "2026-07-27T15:00:00.000Z";

const makeRuntime = (databasePath: string) => {
  const state = makeStateEngineLive(databasePath);
  const repository = Layer.provideMerge(
    Layer.mergeAll(
      makeStationRepositoryLive({
        makeInstallationId: () => LOCAL,
        now: () => NOW,
      }),
      WorkRepositoryLive,
    ),
    state,
  );
  return ManagedRuntime.make(
    Layer.provideMerge(StationApiLive, repository),
  );
};

const makeServer = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-station-control-"));
  roots.push(root);
  const runtime = makeRuntime(join(root, "state", "vellum.db"));
  runtimes.push(runtime);
  const server = await startStationControlServer({
    stationHome: join(root, "station"),
    run: (effect) => runtime.runPromise(effect),
    readiness: () => ({
      database: true,
      workControl: true,
      simulation: true,
    }),
  });
  servers.push(server);
  return { root, runtime, server };
};

const requestOptions = (server: StationControlServer) => ({
  socketPath: server.socketPath,
  timeoutMs: 2_000,
});

const pairRequest = () =>
  PairRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "pair",
    commandCenterInstallationId: COMMAND_CENTER,
    stationInstallationId: LOCAL,
    stationLabel: "Studio Mini",
    appVersion: "0.1.0",
  });

const configureRequest = () =>
  ConfigureRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "configure",
    installationId: LOCAL,
    configuration: {
      role: "remote",
      hostId: decodeHostId("studio"),
      agentHostId: decodeHostId("studio"),
      commandCenterInstallationId: COMMAND_CENTER,
      commandCenterRef: "cc.tailnet",
      supervisedPreferred: true,
    },
  });

const projectRequest = () => {
  const body = compileStationPortfolioBody(
    new Map([["factory", { nodes: [], edges: [] }]]),
  );
  return ProjectRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "project",
    stationInstallationId: LOCAL,
    projection: {
      scope: "full",
      generation: decodeSequence("1"),
      body,
      contentSha256: stationProjectionContentSha256(body),
      createdAt: NOW,
    },
  });
};

const rawCall = (
  socketPath: string,
  frame: string,
): Promise<StationControlEnvelope> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("station control test timed out"));
    }, 2_000);
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, part]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.destroy();
      const decoded = decodeStationControlEnvelope(
        JSON.parse(buffer.subarray(0, newline).toString("utf8")),
      );
      if (Either.isLeft(decoded)) {
        reject(new Error("malformed test response"));
        return;
      }
      resolve(decoded.right);
    });
    socket.once("error", reject);
  });

const runStationCli = (
  stationHome: string,
  request: unknown,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", ["scripts/station-cli.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VELLUM_STATION_HOME: stationHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(JSON.stringify(request));
  });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("Station API control transport", () => {
  it("owns a private socket and drives pair/configure/project/status through the app runtime", async () => {
    const { server } = await makeServer();
    const directoryStat = await stat(server.stationHome);
    const socketStat = await stat(server.socketPath);
    expect(directoryStat.isDirectory()).toBe(true);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o600);

    const before = await sendStationControlRequest(
      StatusRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "status",
      }),
      requestOptions(server),
    );
    expect(before).toMatchObject({
      ok: true,
      response: {
        op: "status",
        installationId: LOCAL,
        state: "unenrolled",
      },
    });

    const paired = await sendStationControlRequest(
      pairRequest(),
      requestOptions(server),
    );
    expect(paired).toMatchObject({
      ok: true,
      response: {
        op: "pair",
        stationInstallationId: LOCAL,
        commandCenterInstallationId: COMMAND_CENTER,
      },
    });

    const configured = await sendStationControlRequest(
      configureRequest(),
      requestOptions(server),
    );
    expect(configured).toMatchObject({
      ok: true,
      response: {
        op: "configure",
        installationId: LOCAL,
        configuration: { role: "remote", hostId: "studio" },
      },
    });

    const projected = await sendStationControlRequest(
      projectRequest(),
      requestOptions(server),
    );
    expect(projected).toMatchObject({
      ok: true,
      response: {
        op: "project",
        decision: "install",
        active: { generation: "1" },
      },
    });

    const after = await sendStationControlRequest(
      StatusRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "status",
      }),
      requestOptions(server),
    );
    expect(after).toMatchObject({
      ok: true,
      response: {
        op: "status",
        state: "ready",
        projection: { generation: "1" },
        readiness: {
          database: true,
          workControl: true,
          simulation: true,
        },
      },
    });
  });

  it("exchanges canonical work and ACKs only after durable materialization", async () => {
    const { runtime, server } = await makeServer();
    await sendStationControlRequest(
      pairRequest(),
      requestOptions(server),
    );
    await sendStationControlRequest(
      configureRequest(),
      requestOptions(server),
    );
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "vellum-station-source-"),
    );
    roots.push(sourceRoot);
    const sourceRuntime = ManagedRuntime.make(
      Layer.provideMerge(
        WorkRepositoryLive,
        makeStateEngineLive(join(sourceRoot, "vellum.db")),
      ),
    );
    const source = await sourceRuntime.runPromise(WorkRepository);
    const remoteWork = await runtime.runPromise(WorkRepository);
    const doc: CanvasDoc = {
      nodes: [{
        id: "tasks",
        type: "text",
        text: "station work",
        x: 0,
        y: 0,
        width: 220,
        height: 100,
        ether: {
          entity: { kind: "task" },
          host: "studio",
        },
      }],
      edges: [],
    };
    let message = 0;
    const ids = {
      id: () => "task-1",
      messageId: () => `message-${++message}`,
    };
    const created = await sourceRuntime.runPromise(
      source.mutate({
        canvasName: "factory",
        nodeId: "tasks",
        entityHome: "studio",
        eventHome: COMMAND_CENTER,
        materialization: "on-disposition",
        operation: "task.create",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskCreate(
            projected,
            "factory",
            "tasks",
            "ship the station",
            undefined,
            ids,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    const [command] = (
      await sourceRuntime.runPromise(
        source.eventsAfter({
          eventHome: COMMAND_CENTER,
          entityHome: "studio",
          afterSeq: "0",
        }),
      )
    ).map(stationEventFromWorkEvent);

    const first = await sendStationControlRequest(
      ReportRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        stationInstallationId: LOCAL,
        outbound: [command!],
        acknowledgeInbound: [],
      }),
      requestOptions(server),
    );
    expect(first).toMatchObject({
      ok: true,
      response: {
        op: "report",
        inbound: [{
          identity: { home: LOCAL, sequence: "1" },
          kind: "work.event",
        }],
        acknowledgeOutbound: [
          { home: COMMAND_CENTER, through: "1" },
        ],
      },
    });

    const applied = await runtime.runPromise(
      remoteWork.readSnapshot("factory", "tasks"),
    );
    expect(applied.tasks.items[0]?.history[0]?.parts[0]).toEqual({
      kind: "text",
      text: "ship the station",
    });
    expect(applied.messages.items).toEqual([]);

    await runtime.runPromise(
      remoteWork.mutate({
        canvasName: "factory",
        nodeId: "tasks",
        entityHome: "studio",
        eventHome: LOCAL,
        materialization: "immediate",
        operation: "task.claim",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskClaim(
            projected,
            "factory",
            "tasks",
            created.value.id,
            "agent-studio",
            ids,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );

    const resultReport = await sendStationControlRequest(
      ReportRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        stationInstallationId: LOCAL,
        outbound: [],
        acknowledgeInbound: [
          { home: LOCAL, through: decodeSequence("1") },
        ],
      }),
      requestOptions(server),
    );
    expect(resultReport).toMatchObject({
      ok: true,
      response: {
        op: "report",
        inbound: [{
          identity: { home: LOCAL, sequence: "2" },
          kind: "work.event",
        }],
        acknowledgeOutbound: [
          { home: COMMAND_CENTER, through: "1" },
        ],
      },
    });

    const retry = await sendStationControlRequest(
      ReportRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        stationInstallationId: LOCAL,
        outbound: [command!],
        acknowledgeInbound: [
          { home: LOCAL, through: decodeSequence("2") },
        ],
      }),
      requestOptions(server),
    );
    expect(retry).toMatchObject({
      ok: true,
      response: {
        op: "report",
        inbound: [],
        acknowledgeOutbound: [
          { home: COMMAND_CENTER, through: "1" },
        ],
      },
    });
    await sourceRuntime.dispose();
  });

  it("fails malformed frames and unpaired report traffic closed", async () => {
    const { server } = await makeServer();
    const malformed = await rawCall(server.socketPath, "{broken\n");
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "protocol_error", retryable: false },
    });

    const report = await sendStationControlRequest(
      ReportRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        stationInstallationId: LOCAL,
        outbound: [],
        acknowledgeInbound: [],
      }),
      requestOptions(server),
    );
    expect(report).toMatchObject({
      ok: false,
      error: { code: "request_rejected", retryable: false },
    });
  });

  it("returns a typed refusal for a SHA-valid non-portfolio projection", async () => {
    const { server } = await makeServer();
    await sendStationControlRequest(pairRequest(), requestOptions(server));
    await sendStationControlRequest(configureRequest(), requestOptions(server));
    const body = "{}";

    const rejected = await sendStationControlRequest(
      ProjectRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "project",
        stationInstallationId: LOCAL,
        projection: {
          scope: "full",
          generation: decodeSequence("1"),
          body,
          contentSha256: stationProjectionContentSha256(body),
          createdAt: NOW,
        },
      }),
      requestOptions(server),
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "request_rejected", retryable: false },
    });

    const repository = await runtimes.at(-1)!.runPromise(StationRepository);
    expect(
      await runtimes.at(-1)!.runPromise(repository.projection),
    ).toBeUndefined();
  });

  it("does not expose repository access through the standalone client", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "station-cli.ts"),
      "utf8",
    );
    const client = await readFile(
      join(
        process.cwd(),
        "src",
        "main",
        "vellum",
        "station",
        "control-client.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/StateEngine|StationRepository|node:sqlite/);
    expect(client).not.toMatch(/StateEngine|StationRepository|node:sqlite/);
    expect(source).not.toMatch(
      /incoming\.frame|applied\.ack|settings\.json/,
    );
  });

  it("runs the fixed stdin CLI entirely through the app-owned socket", async () => {
    const { server } = await makeServer();
    const result = await runStationCli(
      server.stationHome,
      StatusRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "status",
      }),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      response: {
        op: "status",
        installationId: LOCAL,
        state: "unenrolled",
      },
    });
  });

  it("withdraws the exact listener on shutdown", async () => {
    const { server } = await makeServer();
    const receipt = await server.close();
    expect(receipt).toEqual({
      clean: true,
      pendingDispatches: 0,
      openSockets: 0,
      listenerRetained: false,
      socketPathRetained: false,
    });

    const response = await sendStationControlRequest(
      StatusRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "status",
      }),
      requestOptions(server),
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "runtime_down", retryable: true },
    });
  });

  it("keeps the StationApi service as the sole dispatch dependency", async () => {
    const { runtime } = await makeServer();
    const service = await runtime.runPromise(StationApiService);
    expect(service.handle).toBeTypeOf("function");
  });
});
