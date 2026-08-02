import { spawn } from "node:child_process";
import { createServer as createNetServer, createConnection } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Result, Schema } from "effect";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  InstallationId,
  ProjectRequest,
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
  type ReportRequest as ReportRequestValue,
  type StationApiRequest as StationApiRequestValue,
  type StationReadiness,
} from "../src/shared/station-api";
import {
  stationControlOk,
} from "../src/shared/station-api-envelope";
import {
  encodeStationControlFrame,
  stationControlSocketPath,
} from "../src/shared/station-ssh-control";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  STATION_PROTOCOL_PREFACE,
  StationProtocolOffer,
  StationProtocolSupport,
  decodeStationProtocolPreface,
  type StationProtocolPreface,
} from "../src/shared/station-protocol";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  StationSessionResponseFrame,
  decodeStationSessionFrame,
  type StationSessionFrame,
} from "../src/shared/station-session";
import {
  StationApiService,
} from "../src/main/vellum/station/api";
import {
  StationControlReportError,
  startStationControlServer,
  stationControlReadiness,
  type StationControlRequestAdmission,
  type StationControlServer,
} from "../src/main/vellum/station/control-server";
import {
  relayStationControlSession,
} from "../src/main/vellum/station/control-relay";
import {
  makeOwnerLocalStationControlHandoffAuthority,
  type StationControlLocalHandoffAuthority,
} from "../src/main/vellum/station/peer-authority";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const REMOTE = decodeInstallationId("remote-01");
const COMMAND_CENTER = decodeInstallationId("cc-01");
const OBSERVED_AT = "2026-07-27T15:00:00.000Z";

const roots: string[] = [];
const stationServers: StationControlServer[] = [];
const netServers: NetServer[] = [];

const closeNetServer = (server: NetServer): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

afterEach(async () => {
  await Promise.allSettled(
    stationServers.splice(0).map((server) => server.close()),
  );
  await Promise.allSettled(
    netServers.splice(0).map(closeNetServer),
  );
  await Promise.allSettled(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

interface ServerFixture {
  readonly server: StationControlServer;
  readonly handled: () => number;
  readonly observedReadiness: () => StationReadiness | undefined;
}

const makeServer = async (options: {
  readonly localHandoffAuthority?: StationControlLocalHandoffAuthority;
  readonly maxFrameBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly admitRequest?: StationControlRequestAdmission;
} = {}): Promise<ServerFixture> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-station-stream-"));
  roots.push(root);
  let handled = 0;
  let readiness: StationReadiness | undefined;
  const service = StationApiService.of({
    handle: (request, observed) => {
      handled += 1;
      readiness = observed;
      if (request.op !== "status") {
        return Effect.dieMessage("focused fixture accepts status only");
      }
      return Effect.succeed(
        StatusResponse.make({
          protocol: STATION_API_PROTOCOL,
          op: "status",
          installationId: REMOTE,
          state: "ready",
          receivedThrough: [],
          peerAcknowledgedThrough: [],
          readiness: observed,
          observedAt: OBSERVED_AT,
        }),
      );
    },
    prepareReport: () =>
      Effect.dieMessage(
        "focused control-stream fixture does not prepare domain reports",
      ),
    acceptReportResponse: () =>
      Effect.dieMessage(
        "focused control-stream fixture does not integrate domain reports",
      ),
  });
  const server = await startStationControlServer({
    stationHome: join(root, "station"),
    localHandoffAuthority:
      options.localHandoffAuthority ??
        makeOwnerLocalStationControlHandoffAuthority(),
    maxFrameBytes: options.maxFrameBytes,
    requestTimeoutMs: options.requestTimeoutMs,
    admitRequest: options.admitRequest,
    appVersion: "test-remote",
    stateSchemaVersion: 1,
    readiness: () => ({
      database: true,
      workControl: true,
      simulation: true,
    }),
    run: (effect) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(StationApiService, service)),
      ),
  });
  stationServers.push(server);
  return {
    server,
    handled: () => handled,
    observedReadiness: () => readiness,
  };
};

const connect = (socketPath: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const onError = (error: Error): void => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.on("error", () => undefined);
      resolve(socket);
    });
  });

const withTimeout = <A>(
  promise: Promise<A>,
  message: string,
  timeoutMs = 2_000,
): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

interface FrameReader {
  readonly next: () => Promise<StationSessionFrame>;
  readonly nextPreface: () => Promise<StationProtocolPreface>;
}

const makeFrameReader = (socket: Socket): FrameReader => {
  type WireFrame = StationSessionFrame | StationProtocolPreface;
  let buffer = Buffer.alloc(0);
  const queued: WireFrame[] = [];
  const waiting: Array<{
    readonly resolve: (frame: WireFrame) => void;
    readonly reject: (error: Error) => void;
  }> = [];

  const publish = (frame: WireFrame): void => {
    const waiter = waiting.shift();
    if (waiter === undefined) {
      queued.push(frame);
      return;
    }
    waiter.resolve(frame);
  };
  socket.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([
      buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const raw = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      buffer = buffer.subarray(newline + 1);
      const preface = decodeStationProtocolPreface(raw);
      if (Result.isSuccess(preface)) {
        publish(preface.right);
        continue;
      }
      const session = decodeStationSessionFrame(raw);
      if (Result.isFailure(session)) {
        const error = new Error("received a malformed Station frame");
        for (const waiter of waiting.splice(0)) waiter.reject(error);
        return;
      }
      publish(session.right);
    }
  });
  socket.once("close", () => {
    const error = new Error("Station session closed before the next frame");
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  });

  const take = (): Promise<WireFrame> => {
    const frame = queued.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
    });
  };

  return {
    next: async () => {
      const frame = await take();
      if (frame.frame === "request" || frame.frame === "response") return frame;
      throw new Error("received a Station negotiation frame instead of session traffic");
    },
    nextPreface: async () => {
      const frame = await take();
      if (
        frame.frame === "offer" ||
        frame.frame === "accept" ||
        frame.frame === "reject"
      ) {
        return frame;
      }
      throw new Error("received Station session traffic before negotiation completed");
    },
  };
};

const requestFrame = (
  requestId: string,
  request: StationApiRequestValue,
) =>
  StationSessionRequestFrame.make({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "request",
    requestId: StationSessionRequestId.make(requestId),
    request,
  });

const statusFrame = (requestId: string) =>
  requestFrame(
    requestId,
    StatusRequest.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
    }),
  );

const emptyProjectRequest = () =>
  Schema.decodeUnknownSync(ProjectRequest)({
    protocol: STATION_API_PROTOCOL,
    op: "project",
    stationInstallationId: REMOTE,
    projection: {
      scope: "full",
      generation: "1",
      sourceCanvasGeneration: "1",
      sourceIntentSha256: "a".repeat(64),
      body: "{}",
      contentSha256: "b".repeat(64),
      createdAt: OBSERVED_AT,
    },
  });

const waitForClose = (socket: Socket): Promise<void> => {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
};

const currentProtocolOffer = () =>
  StationProtocolOffer.make({
    protocol: STATION_PROTOCOL_PREFACE,
    frame: "offer",
    appVersion: "test-command-center",
    stateSchemaVersion: 1,
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  });

const bindNegotiatedSession = async (
  socket: Socket,
  reader: FrameReader,
): Promise<void> => {
  socket.write(encodeStationControlFrame(currentProtocolOffer()));
  const response = await withTimeout(
    reader.nextPreface(),
    "Station protocol negotiation timed out",
  );
  if (response.frame !== "accept") {
    throw new Error(`Station protocol negotiation ${response.frame}ed`);
  }
  expect(response).toMatchObject({
    protocol: STATION_PROTOCOL_PREFACE,
    frame: "accept",
    appVersion: "test-remote",
    stateSchemaVersion: 1,
    selected: STATION_PROTOCOL_BASELINE,
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  });
};

const emptyReportRequest = () =>
  ReportRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "report",
    senderInstallationId: REMOTE,
    targetInstallationId: COMMAND_CENTER,
    batch: {
      records: [],
      acknowledge: [],
      hasMore: false,
    },
  });

const emptyReportResponse = () =>
  ReportResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "report",
    senderInstallationId: COMMAND_CENTER,
    targetInstallationId: REMOTE,
    batch: {
      records: [],
      acknowledge: [],
      hasMore: false,
    },
  });

describe("persistent Station control stream", () => {
  it("owns a private listener and withdraws it exactly on shutdown", async () => {
    const fixture = await makeServer();
    const directory = await stat(fixture.server.stationHome);
    const socket = await stat(fixture.server.socketPath);

    expect(directory.isDirectory()).toBe(true);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);

    await expect(fixture.server.close()).resolves.toEqual({
      clean: true,
      pendingDispatches: 0,
      openSockets: 0,
      listenerRetained: false,
      socketPathRetained: false,
    });
    await expect(stat(fixture.server.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("binds a strict offer before readiness and then serves domain traffic", async () => {
    const fixture = await makeServer();
    const observed: boolean[] = [];
    const becameReady = new Promise<void>((resolve) => {
      fixture.server.subscribeSession((ready) => {
        observed.push(ready);
        if (ready) resolve();
      });
    });
    const socket = await connect(fixture.server.socketPath);
    const reader = makeFrameReader(socket);

    expect(fixture.server.sessionReady()).toBe(false);
    expect(observed).toEqual([false]);
    await expect(
      fixture.server.report(emptyReportRequest()),
    ).rejects.toMatchObject({ failure: "session-unavailable" });

    await bindNegotiatedSession(socket, reader);
    await withTimeout(becameReady, "negotiated session never became ready");
    expect(observed).toEqual([false, true]);
    expect(fixture.server.sessionReady()).toBe(true);

    const request = statusFrame("negotiated-status");
    socket.write(encodeStationControlFrame(request));
    await expect(
      withTimeout(reader.next(), "negotiated status response timed out"),
    ).resolves.toMatchObject({
      frame: "response",
      requestId: request.requestId,
      envelope: {
        ok: true,
        response: {
          op: "status",
          readiness: { session: true },
        },
      },
    });
    expect(fixture.handled()).toBe(1);
  });

  it("denies unadmitted operations at the transport boundary and fails closed", async () => {
    const observedOperations: StationApiRequestValue["op"][] = [];
    const fixture = await makeServer({
      admitRequest: (request) => {
        observedOperations.push(request.op);
        if (request.op === "report") {
          throw new Error("admission probe failed");
        }
        return (
          request.op === "status" ||
          request.op === "pair" ||
          request.op === "configure"
        );
      },
    });
    const socket = await connect(fixture.server.socketPath);
    const reader = makeFrameReader(socket);
    await bindNegotiatedSession(socket, reader);

    const allowed = statusFrame("bootstrap-status");
    socket.write(encodeStationControlFrame(allowed));
    await expect(
      withTimeout(reader.next(), "admitted status response timed out"),
    ).resolves.toMatchObject({
      frame: "response",
      requestId: allowed.requestId,
      envelope: {
        ok: true,
        response: { op: "status" },
      },
    });
    expect(fixture.handled()).toBe(1);

    const project = requestFrame(
      "bootstrap-project",
      emptyProjectRequest(),
    );
    socket.write(encodeStationControlFrame(project));
    await expect(
      withTimeout(reader.next(), "denied project response timed out"),
    ).resolves.toMatchObject({
      frame: "response",
      requestId: project.requestId,
      envelope: {
        ok: false,
        error: {
          code: "authorization_denied",
          message: "station operation is not admitted",
          retryable: false,
        },
      },
    });
    expect(fixture.handled()).toBe(1);

    const report = requestFrame(
      "bootstrap-report",
      emptyReportRequest(),
    );
    socket.write(encodeStationControlFrame(report));
    await expect(
      withTimeout(reader.next(), "fail-closed report response timed out"),
    ).resolves.toMatchObject({
      frame: "response",
      requestId: report.requestId,
      envelope: {
        ok: false,
        error: {
          code: "authorization_denied",
          message: "station operation is not admitted",
          retryable: false,
        },
      },
    });
    expect(fixture.handled()).toBe(1);

    const stillAllowed = statusFrame("bootstrap-status-after-denial");
    socket.write(encodeStationControlFrame(stillAllowed));
    await expect(
      withTimeout(
        reader.next(),
        "session did not survive an operation denial",
      ),
    ).resolves.toMatchObject({
      frame: "response",
      requestId: stillAllowed.requestId,
      envelope: {
        ok: true,
        response: { op: "status" },
      },
    });
    expect(fixture.handled()).toBe(2);
    expect(observedOperations).toEqual([
      "status",
      "project",
      "report",
      "status",
    ]);
    expect(socket.destroyed).toBe(false);
  });

  it("rejects a domain frame before protocol negotiation", async () => {
    const authority = makeOwnerLocalStationControlHandoffAuthority();
    let handoffChecks = 0;
    const fixture = await makeServer({
      localHandoffAuthority: {
        capture: authority.capture,
        isCurrent: (socket, handoff) => {
          handoffChecks += 1;
          return authority.isCurrent(socket, handoff);
        },
      },
    });
    const socket = await connect(fixture.server.socketPath);
    const first = statusFrame("status-1");
    const second = statusFrame("status-2");
    const closed = waitForClose(socket);

    socket.write(
      encodeStationControlFrame(first) +
        encodeStationControlFrame(second),
    );

    await withTimeout(closed, "unnegotiated domain frames were not rejected");
    expect(fixture.handled()).toBe(0);
    expect(fixture.server.sessionReady()).toBe(false);
    expect(stationControlReadiness.sessionReady()).toBe(false);
    expect(handoffChecks).toBeGreaterThanOrEqual(1);
  });

  it("publishes exact session readiness transitions for reconciliation wakeups", async () => {
    const fixture = await makeServer();
    const observed: boolean[] = [];
    const unsubscribe = fixture.server.subscribeSession((ready) => {
      observed.push(ready);
    });

    expect(observed).toEqual([false]);
    const socket = await connect(fixture.server.socketPath);
    const reader = makeFrameReader(socket);
    expect(observed).toEqual([false]);
    await bindNegotiatedSession(socket, reader);
    expect(observed).toEqual([false, true]);

    const closed = waitForClose(socket);
    socket.end();
    await withTimeout(closed, "session readiness test did not close");
    expect(observed).toEqual([false, true, false]);

    unsubscribe();
  });

  it("rejects incompatible offers without stopping the listener or local runtime", async () => {
    const fixture = await makeServer();
    const incompatibleSocket = await connect(fixture.server.socketPath);
    const incompatibleReader = makeFrameReader(incompatibleSocket);
    incompatibleSocket.write(
      encodeStationControlFrame(
        StationProtocolOffer.make({
          protocol: STATION_PROTOCOL_PREFACE,
          frame: "offer",
          appVersion: "future-command-center",
          stateSchemaVersion: 4,
          support: StationProtocolSupport.make({
            preferred: 5,
            compatibleFrom: 5,
            warnBelow: 5,
          }),
        }),
      ),
    );

    await expect(
      withTimeout(
        incompatibleReader.nextPreface(),
        "incompatible Station offer did not receive a rejection",
      ),
    ).resolves.toMatchObject({
      frame: "reject",
      reason: "no-common-version",
      retryable: false,
      support: CURRENT_STATION_PROTOCOL_SUPPORT,
    });
    await withTimeout(
      waitForClose(incompatibleSocket),
      "incompatible Station session stayed open",
    );
    expect(fixture.handled()).toBe(0);
    expect(fixture.server.ready()).toBe(true);
    expect(fixture.server.sessionReady()).toBe(false);

    const recoverySocket = await connect(fixture.server.socketPath);
    const recoveryReader = makeFrameReader(recoverySocket);
    await bindNegotiatedSession(recoverySocket, recoveryReader);
    const request = statusFrame("recovery-status");
    recoverySocket.write(encodeStationControlFrame(request));
    await expect(
      withTimeout(
        recoveryReader.next(),
        "listener did not accept a compatible session after rejection",
      ),
    ).resolves.toMatchObject({
      frame: "response",
      requestId: request.requestId,
    });
    expect(fixture.server.sessionReady()).toBe(true);
    expect(fixture.handled()).toBe(1);
  });

  it("times out an unbound peer that never sends its first frame", async () => {
    const fixture = await makeServer({ requestTimeoutMs: 50 });
    const socket = await connect(fixture.server.socketPath);
    expect(fixture.server.sessionReady()).toBe(false);
    await withTimeout(
      waitForClose(socket),
      "silent unbound Station session stayed open",
    );
    expect(fixture.server.ready()).toBe(true);
    expect(fixture.server.sessionReady()).toBe(false);
    expect(fixture.handled()).toBe(0);
  });

  it("does not let a competing socket replace an unbound admitted peer", async () => {
    const fixture = await makeServer();
    const admitted = await connect(fixture.server.socketPath);
    const admittedReader = makeFrameReader(admitted);
    const competing = await connect(fixture.server.socketPath);

    await withTimeout(
      waitForClose(competing),
      "competing Station session was not rejected",
    );
    expect(admitted.destroyed).toBe(false);
    expect(fixture.server.sessionReady()).toBe(false);

    await bindNegotiatedSession(admitted, admittedReader);
    expect(fixture.server.sessionReady()).toBe(true);
  });

  it("closes malformed, oversized, and stale-handoff sessions", async () => {
    const malformed = await makeServer();
    const malformedSocket = await connect(malformed.server.socketPath);
    malformedSocket.write("{broken\n");
    await withTimeout(
      waitForClose(malformedSocket),
      "malformed session stayed open",
    );
    expect(malformed.handled()).toBe(0);

    const excess = await makeServer();
    const excessSocket = await connect(excess.server.socketPath);
    excessSocket.write(
      encodeStationControlFrame({
        ...currentProtocolOffer(),
        ignoredCapability: true,
      }),
    );
    await withTimeout(
      waitForClose(excessSocket),
      "excess-property negotiation session stayed open",
    );
    expect(excess.handled()).toBe(0);
    expect(excess.server.ready()).toBe(true);

    const oversized = await makeServer({ maxFrameBytes: 128 });
    const oversizedSocket = await connect(oversized.server.socketPath);
    oversizedSocket.write(Buffer.alloc(128, 0x61));
    await withTimeout(
      waitForClose(oversizedSocket),
      "oversized session stayed open",
    );
    expect(oversized.handled()).toBe(0);

    const authority = makeOwnerLocalStationControlHandoffAuthority();
    let handoffChecks = 0;
    const changed = await makeServer({
      localHandoffAuthority: {
        capture: authority.capture,
        isCurrent: (socket, handoff) => {
          handoffChecks += 1;
          return (
            handoffChecks <= 2 &&
            authority.isCurrent(socket, handoff)
          );
        },
      },
    });
    const changedSocket = await connect(changed.server.socketPath);
    const changedReader = makeFrameReader(changedSocket);
    await bindNegotiatedSession(changedSocket, changedReader);
    changedSocket.write(encodeStationControlFrame(statusFrame("changed")));
    await withTimeout(
      waitForClose(changedSocket),
      "stale-handoff session stayed open",
    );
    expect(handoffChecks).toBe(3);
    expect(changed.handled()).toBe(0);
  });

  it("correlates Remote-originated report only on the active CC session", async () => {
    const fixture = await makeServer();
    await expect(
      fixture.server.report(emptyReportRequest()),
    ).rejects.toMatchObject({
      failure: "session-unavailable",
    });

    const socket = await connect(fixture.server.socketPath);
    const reader = makeFrameReader(socket);
    await expect(
      fixture.server.report(
        StatusRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "status",
        }) as unknown as ReportRequestValue,
      ),
    ).rejects.toMatchObject({
      failure: "invalid-local-request",
    });

    await bindNegotiatedSession(socket, reader);
    const reportPromise = fixture.server.report(emptyReportRequest());
    const outbound = await withTimeout(
      reader.next(),
      "Remote report request timed out",
    );
    expect(outbound).toMatchObject({
      frame: "request",
      request: {
        op: "report",
        senderInstallationId: REMOTE,
        targetInstallationId: COMMAND_CENTER,
      },
    });
    if (outbound.frame !== "request") {
      throw new Error("expected a request frame");
    }
    socket.write(
      encodeStationControlFrame(
        StationSessionResponseFrame.make({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "response",
          requestId: outbound.requestId,
          envelope: stationControlOk(emptyReportResponse()),
        }),
      ),
    );

    await expect(reportPromise).resolves.toMatchObject({
      op: "report",
      senderInstallationId: COMMAND_CENTER,
      targetInstallationId: REMOTE,
    });
  });

  it("closes an unsolicited response rather than treating it as a request", async () => {
    const fixture = await makeServer();
    const socket = await connect(fixture.server.socketPath);
    socket.write(
      encodeStationControlFrame(
        StationSessionResponseFrame.make({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "response",
          requestId: StationSessionRequestId.make("unsolicited"),
          envelope: stationControlOk(emptyReportResponse()),
        }),
      ),
    );
    await withTimeout(
      waitForClose(socket),
      "unsolicited response session stayed open",
    );
    expect(fixture.server.sessionReady()).toBe(false);
  });

  it("rejects and closes a correlated report with reversed direction", async () => {
    const fixture = await makeServer();
    const socket = await connect(fixture.server.socketPath);
    const reader = makeFrameReader(socket);
    await bindNegotiatedSession(socket, reader);
    const report = fixture.server.report(emptyReportRequest());
    const outbound = await withTimeout(
      reader.next(),
      "Remote report request timed out",
    );
    if (outbound.frame !== "request") {
      throw new Error("expected a request frame");
    }
    socket.write(
      encodeStationControlFrame(
        StationSessionResponseFrame.make({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "response",
          requestId: outbound.requestId,
          envelope: stationControlOk(
            ReportResponse.make({
              protocol: STATION_API_PROTOCOL,
              op: "report",
              senderInstallationId: REMOTE,
              targetInstallationId: COMMAND_CENTER,
              batch: {
                records: [],
                acknowledge: [],
                hasMore: false,
              },
            }),
          ),
        }),
      ),
    );

    await expect(report).rejects.toMatchObject({
      failure: "protocol-error",
    });
    await withTimeout(
      waitForClose(socket),
      "invalid-direction session stayed open",
    );
  });

  it("bounds unanswered Remote report correlation by timeout", async () => {
    const fixture = await makeServer({ requestTimeoutMs: 100 });
    const socket = await connect(fixture.server.socketPath);
    const reader = makeFrameReader(socket);
    await bindNegotiatedSession(socket, reader);
    const report = fixture.server.report(emptyReportRequest());
    await withTimeout(
      reader.next(),
      "Remote report request timed out before it was written",
    );

    await expect(report).rejects.toMatchObject({
      failure: "request-timeout",
    });
    await withTimeout(
      waitForClose(socket),
      "timed-out report session stayed open",
    );
  });
});

describe("packaged Station relay", () => {
  it("relays arbitrary bytes unchanged in both directions until session close", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-station-relay-"));
    roots.push(root);
    const stationHome = join(root, "station");
    await mkdir(stationHome, { recursive: true });
    const socketPath = stationControlSocketPath(stationHome);
    let acceptedResolve: ((socket: Socket) => void) | undefined;
    const accepted = new Promise<Socket>((resolve) => {
      acceptedResolve = resolve;
    });
    const server = createNetServer((socket) => acceptedResolve?.(socket));
    netServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const outputChunks: Buffer[] = [];
    output.on("data", (chunk: Buffer | string) => {
      outputChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    });
    const relay = relayStationControlSession(
      { stationHome },
      { input, output },
    );
    const remote = await withTimeout(
      accepted,
      "relay did not open its one UDS connection",
    );
    const inputChunks: Buffer[] = [];
    remote.on("data", (chunk: Buffer | string) => {
      inputChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    });
    remote.once("end", () => remote.end());

    const outbound = Buffer.from([0xff, 0x00, 0x7b, 0x0a, 0x41]);
    const inbound = Buffer.from([0xfe, 0x10, 0x0a, 0x42]);
    input.write(outbound.subarray(0, 2));
    input.end(outbound.subarray(2));
    remote.write(inbound);

    await withTimeout(relay, "relay did not close with the UDS session");
    expect(Buffer.concat(inputChunks)).toEqual(outbound);
    expect(Buffer.concat(outputChunks)).toEqual(inbound);
  });

  it("rejects arguments without emitting a protocol frame", async () => {
    const child = spawn(
      "bun",
      ["scripts/station-cli.ts", "unexpected"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await withTimeout(
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      }),
      "vellum-station argument rejection timed out",
    );

    expect(exitCode).toBe(64);
    expect(Buffer.concat(stdout)).toEqual(Buffer.alloc(0));
    expect(Buffer.concat(stderr).toString("utf8")).toBe(
      "vellum-station: arguments are not accepted\n",
    );
  });

  it("uses typed report failures for local correlation errors", () => {
    const error = new StationControlReportError(
      "protocol-error",
      "test",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.failure).toBe("protocol-error");
  });
});
