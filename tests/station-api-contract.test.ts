import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ConfigureRequest,
  InstallationId,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  ReportRequest,
  STATION_API_MAX_EVENTS_PER_REPORT,
  STATION_API_PROTOCOL,
  StationEvent,
  StationEventAck,
  StationEventIdentity,
  StationProjectionBody,
  StationProjectionReference,
  StatusResponse,
  coalesceStationEvents,
  compareLogicalSequence,
  contiguousReceivedThrough,
  decideAckAdvance,
  decideProjectionInstall,
  type StationSha256,
} from "../src/shared/station-api";
import { decodeStationControlRequest } from "../src/shared/station-control";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
const decodeHash = Schema.decodeUnknownSync(
  Schema.String.pipe(
    Schema.pattern(/^[a-f0-9]{64}$/),
    Schema.brand("StationSha256"),
  ),
);
const decodeEventIdentity = Schema.decodeUnknownSync(StationEventIdentity);
const decodeAck = Schema.decodeUnknownSync(StationEventAck);
const decodeEvent = Schema.decodeUnknownSync(StationEvent);

const cc = decodeInstallationId("cc-01");
const remote = decodeInstallationId("remote-01");
const hash = (digit: string): StationSha256 => decodeHash(digit.repeat(64));

const event = (input: {
  readonly home?: string;
  readonly sequence: string;
  readonly content?: string;
  readonly timestamp?: string;
}) =>
  decodeEvent({
    identity: {
      home: input.home ?? remote,
      sequence: input.sequence,
    },
    kind: "work.transition",
    body: JSON.stringify({ content: input.content ?? "done" }),
    contentSha256: hash(input.content === "different" ? "b" : "a"),
    originAt: input.timestamp ?? "2026-07-27T15:00:00.000Z",
  });

describe("Station API wire schemas", () => {
  it("decodes one bounded, credential-free contract for every verb", () => {
    const pair = Schema.decodeUnknownSync(PairRequest)({
      protocol: STATION_API_PROTOCOL,
      op: "pair",
      commandCenterInstallationId: cc,
      stationInstallationId: remote,
      stationLabel: "Studio Mini",
      appVersion: "0.1.0",
    });
    expect(pair.op).toBe("pair");

    const configure = Schema.decodeUnknownSync(ConfigureRequest)({
      protocol: STATION_API_PROTOCOL,
      op: "configure",
      installationId: remote,
      configuration: {
        role: "remote",
        hostId: "studio",
        agentHostId: "studio",
        commandCenterInstallationId: cc,
        commandCenterRef: "cc.tailnet",
        supervisedPreferred: true,
      },
    });
    expect(configure.configuration.role).toBe("remote");

    const project = Schema.decodeUnknownSync(ProjectRequest)({
      protocol: STATION_API_PROTOCOL,
      op: "project",
      stationInstallationId: remote,
      projection: {
        scope: "full",
        generation: "9007199254740993",
        body: JSON.stringify({ canvases: [] }),
        contentSha256: hash("a"),
        createdAt: "2026-07-27T15:00:00.000Z",
      },
    });
    expect(project.projection.generation).toBe("9007199254740993");

    const report = Schema.decodeUnknownSync(ReportRequest)({
      protocol: STATION_API_PROTOCOL,
      op: "report",
      stationInstallationId: remote,
      outbound: [event({ home: cc, sequence: "1" })],
      acknowledgeInbound: [{ home: remote, through: "9" }],
    });
    expect(report.outbound).toHaveLength(1);

    const status = Schema.decodeUnknownSync(StatusResponse)({
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: remote,
      state: "ready",
      configuration: configure.configuration,
      configuredAt: "2026-07-27T14:00:00.000Z",
      projection: {
        generation: project.projection.generation,
        contentSha256: project.projection.contentSha256,
        receivedAt: "2026-07-27T15:00:01.000Z",
      },
      receivedThrough: [{ home: cc, through: "1" }],
      readiness: {
        database: true,
        workControl: true,
        simulation: true,
      },
      observedAt: "2026-07-27T15:00:02.000Z",
    });
    expect(status.readiness.simulation).toBe(true);
  });

  it("rejects unsafe numeric sequences, non-canonical decimals, and oversized batches", () => {
    expect(() => decodeSequence(9_007_199_254_740_993)).toThrow();
    expect(() => decodeSequence("01")).toThrow();
    expect(() => decodeSequence("-1")).toThrow();
    expect(() => decodeSequence("1".repeat(33))).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(ReportRequest)({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        stationInstallationId: remote,
        outbound: Array.from(
          { length: STATION_API_MAX_EVENTS_PER_REPORT + 1 },
          (_, index) => event({ home: cc, sequence: String(index + 1) }),
        ),
        acknowledgeInbound: [],
      }),
    ).toThrow();
  });

  it("keeps Remote-only configuration facts mandatory", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigureRequest)({
        protocol: STATION_API_PROTOCOL,
        op: "configure",
        installationId: remote,
        configuration: {
          role: "remote",
          hostId: "studio",
          supervisedPreferred: true,
        },
      }),
    ).toThrow();
  });

  it("makes Command Center promotion and excess credentials unrepresentable on the wire", () => {
    const commandCenter = decodeStationControlRequest({
      protocol: STATION_API_PROTOCOL,
      op: "configure",
      installationId: remote,
      configuration: {
        role: "command-center",
        hostId: "command",
        supervisedPreferred: true,
      },
    });
    expect(Either.isLeft(commandCenter)).toBe(true);

    const excessCredential = decodeStationControlRequest({
      protocol: STATION_API_PROTOCOL,
      op: "pair",
      commandCenterInstallationId: cc,
      stationInstallationId: remote,
      stationLabel: "Studio Mini",
      appVersion: "0.1.0",
      legacyToken: "must-not-enter-the-domain",
    });
    expect(Either.isLeft(excessCredential)).toBe(true);
  });
});

describe("Station API monotonic decisions", () => {
  const projection = (
    generation: string,
    contentSha256: StationSha256 = hash("a"),
  ) =>
    Schema.decodeUnknownSync(StationProjectionBody)({
      scope: "full",
      generation,
      body: "{}",
      contentSha256,
      createdAt: "2026-07-27T15:00:00.000Z",
    });

  const current = (
    generation: string,
    contentSha256: StationSha256 = hash("a"),
  ) =>
    Schema.decodeUnknownSync(StationProjectionReference)({
      generation,
      contentSha256,
      receivedAt: "2026-07-27T15:00:01.000Z",
    });

  it("orders logical numbers with BigInt rather than unsafe Number coercion", () => {
    expect(
      compareLogicalSequence(
        decodeSequence("9007199254740993"),
        decodeSequence("9007199254740992"),
      ),
    ).toBe(1);
  });

  it("installs only higher projections and separates replay, stale, and conflict", () => {
    expect(decideProjectionInstall(undefined, projection("1"))).toBe("install");
    expect(decideProjectionInstall(current("9"), projection("10"))).toBe(
      "install",
    );
    expect(decideProjectionInstall(current("10"), projection("9"))).toBe(
      "stale",
    );
    expect(decideProjectionInstall(current("10"), projection("10"))).toBe(
      "idempotent",
    );
    expect(
      decideProjectionInstall(current("10"), projection("10", hash("b"))),
    ).toBe("conflict");
  });

  it("never regresses or substitutes a cumulative ACK", () => {
    const admitted = decodeAck({ home: remote, through: "10" });

    expect(
      decideAckAdvance(admitted, decodeAck({ home: remote, through: "11" })),
    ).toEqual({
      _tag: "advanced",
      cursor: decodeAck({ home: remote, through: "11" }),
    });
    expect(
      decideAckAdvance(admitted, decodeAck({ home: remote, through: "10" })),
    ).toEqual({ _tag: "idempotent", cursor: admitted });
    expect(
      decideAckAdvance(admitted, decodeAck({ home: remote, through: "9" })),
    ).toEqual({
      _tag: "regression",
      cursor: admitted,
      rejected: decodeAck({ home: remote, through: "9" }),
    });
    expect(
      decideAckAdvance(admitted, decodeAck({ home: cc, through: "11" })),
    ).toEqual({
      _tag: "home-mismatch",
      cursor: admitted,
      rejected: decodeAck({ home: cc, through: "11" }),
    });
  });

  it("advances through contiguous identities only, ignoring duplicates and timestamps", () => {
    const cursor = decodeAck({ home: remote, through: "3" });
    const first = contiguousReceivedThrough(cursor, [
      event({ sequence: "5", timestamp: "2026-07-27T10:00:00.000Z" }).identity,
      event({ sequence: "4", timestamp: "2026-07-27T18:00:00.000Z" }).identity,
      event({ sequence: "4", timestamp: "2026-07-27T09:00:00.000Z" }).identity,
      event({ sequence: "7" }).identity,
      decodeEventIdentity({ home: cc, sequence: "4" }),
    ]);
    expect(first).toEqual(decodeAck({ home: remote, through: "5" }));

    const second = contiguousReceivedThrough(first, [
      event({ sequence: "7" }).identity,
      event({ sequence: "6" }).identity,
    ]);
    expect(second).toEqual(decodeAck({ home: remote, through: "7" }));
  });

  it("coalesces identical event retries and fails closed on identity reuse", () => {
    const first = event({ sequence: "1" });
    const retry = event({
      sequence: "1",
      timestamp: "2026-07-27T20:00:00.000Z",
    });
    const second = event({ sequence: "2" });

    expect(coalesceStationEvents([first, retry, second])).toEqual({
      _tag: "accepted",
      events: [first, second],
    });

    expect(
      coalesceStationEvents([
        first,
        event({ sequence: "1", content: "different" }),
      ]),
    ).toEqual({
      _tag: "identity-conflict",
      identity: first.identity,
      admittedContentSha256: hash("a"),
      rejectedContentSha256: hash("b"),
    });
  });
});
