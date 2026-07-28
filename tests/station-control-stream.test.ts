import { spawn } from "node:child_process";
import { createServer as createNetServer, createConnection } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Either, Schema } from "effect";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  InstallationId,
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
  type ReportRequest as ReportRequestValue,
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
  type StationControlServer,
} from "../src/main/vellum/station/control-server";
import {
  relayStationControlSession,
} from "../src/main/vellum/station/control-relay";
import type {
  StationControlPeerAuthority,
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

const admittedPeer: StationControlPeerAuthority = {
  capture: () => ({
    snapshot: {
      platform: "Darwin",
      peerPid: 101,
      peerUid: 501,
      chain: [{
        pid: 101,
        ppid: 100,
        uid: 501,
        startKey: "1:0",
        executable: "/test/vellum-station",
        device: "1",
        inode: "1",
      }, {
        pid: 100,
        ppid: 1,
        uid: 0,
        startKey: "1:0",
        executable: "/usr/sbin/sshd",
        device: "1",
        inode: "2",
      }],
    },
  }),
  revalidate: () => true,
};

interface ServerFixture {
  readonly server: StationControlServer;
  readonly handled: () => number;
  readonly observedReadiness: () => StationReadiness | undefined;
}

const makeServer = async (options: {
  readonly peerAuthority?: StationControlPeerAuthority;
  readonly maxFrameBytes?: number;
  readonly requestTimeoutMs?: number;
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
  });
  const server = await startStationControlServer({
    stationHome: join(root, "station"),
    peerAuthority: options.peerAuthority ?? admittedPeer,
    maxFrameBytes: options.maxFrameBytes,
    requestTimeoutMs: options.requestTimeoutMs,
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
}

const makeFrameReader = (socket: Socket): FrameReader => {
  let buffer = Buffer.alloc(0);
  const queued: StationSessionFrame[] = [];
  const waiting: Array<{
    readonly resolve: (frame: StationSessionFrame) => void;
    readonly reject: (error: Error) => void;
  }> = [];

  const publish = (frame: StationSessionFrame): void => {
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
      const decoded = decodeStationSessionFrame(raw);
      if (Either.isLeft(decoded)) {
        const error = new Error("received a malformed Station frame");
        for (const waiter of waiting.splice(0)) waiter.reject(error);
        return;
      }
      publish(decoded.right);
    }
  });
  socket.once("close", () => {
    const error = new Error("Station session closed before the next frame");
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  });

  return {
    next: () => {
      const frame = queued.shift();
      if (frame !== undefined) return Promise.resolve(frame);
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
  };
};

const statusFrame = (requestId: string) =>
  StationSessionRequestFrame.make({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "request",
    requestId: StationSessionRequestId.make(requestId),
    request: StatusRequest.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
    }),
  });

const waitForClose = (socket: Socket): Promise<void> => {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
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
  it("serves multiple strict NDJSON requests in order on one admitted session", async () => {
    let revalidations = 0;
    const fixture = await makeServer({
      peerAuthority: {
        ...admittedPeer,
        revalidate: () => {
          revalidations += 1;
          return true;
        },
      },
    });
    const socket = await connect(fixture.server.socketPath);
    const reader = makeFrameReader(socket);
    const first = statusFrame("status-1");
    const second = statusFrame("status-2");

    socket.write(
      encodeStationControlFrame(first) +
        encodeStationControlFrame(second),
    );

    const firstResponse = await withTimeout(
      reader.next(),
      "first response timed out",
    );
    const secondResponse = await withTimeout(
      reader.next(),
      "second response timed out",
    );
    expect(firstResponse).toMatchObject({
      frame: "response",
      requestId: first.requestId,
      envelope: {
        ok: true,
        response: {
          op: "status",
          readiness: { session: true },
        },
      },
    });
    expect(secondResponse).toMatchObject({
      frame: "response",
      requestId: second.requestId,
    });
    expect(fixture.handled()).toBe(2);
    expect(fixture.observedReadiness()).toMatchObject({ session: true });
    expect(fixture.server.sessionReady()).toBe(true);
    expect(stationControlReadiness.sessionReady()).toBe(true);
    expect(revalidations).toBeGreaterThanOrEqual(8);
    expect(socket.destroyed).toBe(false);
  });

  it("publishes exact session readiness transitions for reconciliation wakeups", async () => {
    const fixture = await makeServer();
    const observed: boolean[] = [];
    const unsubscribe = fixture.server.subscribeSession((ready) => {
      observed.push(ready);
    });

    expect(observed).toEqual([false]);
    const socket = await connect(fixture.server.socketPath);
    expect(observed).toEqual([false, true]);

    const closed = waitForClose(socket);
    socket.end();
    await withTimeout(closed, "session readiness test did not close");
    expect(observed).toEqual([false, true, false]);

    unsubscribe();
  });

  it("closes malformed, oversized, and authority-changed sessions", async () => {
    const malformed = await makeServer();
    const malformedSocket = await connect(malformed.server.socketPath);
    malformedSocket.write("{broken\n");
    await withTimeout(
      waitForClose(malformedSocket),
      "malformed session stayed open",
    );
    expect(malformed.handled()).toBe(0);

    const oversized = await makeServer({ maxFrameBytes: 128 });
    const oversizedSocket = await connect(oversized.server.socketPath);
    oversizedSocket.write(Buffer.alloc(128, 0x61));
    await withTimeout(
      waitForClose(oversizedSocket),
      "oversized session stayed open",
    );
    expect(oversized.handled()).toBe(0);

    let authorityChecks = 0;
    const changed = await makeServer({
      peerAuthority: {
        ...admittedPeer,
        revalidate: () => {
          authorityChecks += 1;
          return authorityChecks === 1;
        },
      },
    });
    const changedSocket = await connect(changed.server.socketPath);
    changedSocket.write(encodeStationControlFrame(statusFrame("changed")));
    await withTimeout(
      waitForClose(changedSocket),
      "authority-changed session stayed open",
    );
    expect(authorityChecks).toBe(2);
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
