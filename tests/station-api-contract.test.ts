import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as StationApi from "../src/shared/station-api";
import {
  ConfigureRequest,
  InstallationId,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  ReportBatch,
  ReportRequest,
  ReportResponse,
  RouteCursor,
  STATION_API_MAX_ACKS_PER_REPORT,
  STATION_API_MAX_FIRST_DELIVERY_CLAIMS_PER_REPORT,
  STATION_API_MAX_RECORDS_PER_REPORT,
  STATION_API_MAX_REPORT_BATCH_BYTES,
  STATION_API_PROTOCOL,
  StationProjectionBody,
  StationProjectionReference,
  StatusRequest,
  StatusResponse,
  WorkRecord,
  coalesceWorkRecords,
  compareLogicalSequence,
  contiguousRouteCursor,
  decideProjectionInstall,
  decideReportBatchAdmission,
  decideReportDirection,
  decideRouteCursorAdvance,
  reportBatchEncodedByteLength,
  reportResponseSwapsDirection,
} from "../src/shared/station-api";
import { decodeStationControlRequest } from "../src/shared/station-api-envelope";
import {
  WORK_PROTOCOL,
  type WorkRecord as WorkRecordValue,
} from "../src/shared/work-protocol";

const decodeStrict =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (value: unknown) =>
    Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(value);

const cc = Schema.decodeUnknownSync(InstallationId)("cc-installation");
const remote = Schema.decodeUnknownSync(InstallationId)(
  "remote-installation",
);
const other = Schema.decodeUnknownSync(InstallationId)("other-installation");
const timestamp = "2026-07-27T18:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const seatId = `seat_${"d".repeat(64)}`;

const sink = {
  canvasName: "factory",
  nodeId: "tasks",
};

const actor = {
  seatId,
  canvasName: "factory",
  nodeId: "builder",
};

const sourceTask = {
  id: "task-1",
  state: "submitted",
  history: [],
};

const decodeWorkRecord = Schema.decodeUnknownSync(WorkRecord, {
  onExcessProperty: "error",
});

const claimCommand = (
  seq = "1",
  sender = cc,
  target = remote,
): WorkRecordValue =>
  decodeWorkRecord({
    protocol: WORK_PROTOCOL,
    id: {
      route: {
        eventHome: sender,
        entityHome: target,
      },
      seq,
    },
    recordType: "command",
    item: {
      kind: "task",
      itemId: sourceTask.id,
      sink,
    },
    operation: "task.claim",
    contentSha256: hashA,
    originAt: timestamp,
    predecessor: null,
    body: {
      operation: "task.claim",
      sourceQueueHome: sender,
      sourcePredecessor: {
        route: {
          eventHome: sender,
          entityHome: sender,
        },
        seq: "9",
      },
      sourceTask,
      sink,
      actor,
      targetHome: target,
    },
  });

const claimFact = (
  seq = "1",
  sender = remote,
  previousHome = cc,
): WorkRecordValue =>
  decodeWorkRecord({
    protocol: WORK_PROTOCOL,
    id: {
      route: {
        eventHome: sender,
        entityHome: sender,
      },
      seq,
    },
    recordType: "fact",
    item: {
      kind: "task",
      itemId: sourceTask.id,
      sink,
    },
    operation: "task.claim",
    contentSha256: hashB,
    originAt: timestamp,
    predecessor: null,
    body: {
      operation: "task.claim",
      task: {
        ...sourceTask,
        state: "working",
        claimedBy: seatId,
      },
      claimedBy: actor,
      previousHome,
    },
  });

const appliedDisposition = (
  seq = "2",
  sender = remote,
  command = claimCommand(),
  fact = claimFact(),
): WorkRecordValue =>
  decodeWorkRecord({
    protocol: WORK_PROTOCOL,
    id: {
      route: {
        eventHome: sender,
        entityHome: sender,
      },
      seq,
    },
    recordType: "disposition",
    item: command.item,
    operation: "task.claim",
    contentSha256: hashC,
    originAt: timestamp,
    body: {
      status: "applied",
      command: command.id,
      commandSha256: command.contentSha256,
      fact: fact.id,
      factSha256: fact.contentSha256,
    },
  });

const messageFact = (
  seq: string,
  sender = cc,
  text = "done",
): WorkRecordValue =>
  decodeWorkRecord({
    protocol: WORK_PROTOCOL,
    id: {
      route: {
        eventHome: sender,
        entityHome: sender,
      },
      seq,
    },
    recordType: "fact",
    item: {
      kind: "message",
      itemId: `message-${seq}`,
      sink,
    },
    operation: "message.append",
    contentSha256: hashA,
    originAt: timestamp,
    predecessor: null,
    body: {
      operation: "message.append",
      message: {
        messageId: `message-${seq}`,
        role: "agent",
        parts: [{ kind: "text", text }],
      },
      sentBy: actor,
      destination: { kind: "mailbox" },
    },
  });

const cursor = (
  eventHome: typeof cc,
  entityHome: typeof cc,
  through: string,
) =>
  Schema.decodeUnknownSync(RouteCursor, { onExcessProperty: "error" })({
    eventHome,
    entityHome,
    through,
  });

const requestBatch = {
  records: [claimCommand()],
  acknowledge: [cursor(remote, remote, "2")],
  hasMore: false,
};

const responseBatch = {
  records: [claimFact(), appliedDisposition()],
  acknowledge: [cursor(cc, remote, "1")],
  hasMore: false,
};

describe("Station API v2 contract", () => {
  it("decodes the exact five verbs and symmetric report direction", () => {
    const requests = [
      {
        protocol: STATION_API_PROTOCOL,
        op: "pair",
        commandCenterInstallationId: cc,
        stationInstallationId: remote,
        stationLabel: "Remote one",
        appVersion: "0.2.0",
      },
      {
        protocol: STATION_API_PROTOCOL,
        op: "configure",
        installationId: remote,
        configuration: {
          role: "remote",
          hostId: "remote-1",
          agentHostId: "remote-1",
          commandCenterInstallationId: cc,
          supervisedPreferred: true,
        },
        host: {
          id: "remote-1",
          label: "Remote one",
          kind: "remote",
          sshEndpoint: "vellum-remote",
          capabilities: ["terminal", "browser"],
        },
      },
      {
        protocol: STATION_API_PROTOCOL,
        op: "project",
        stationInstallationId: remote,
        projection: {
          scope: "full",
          generation: "1",
          body: '{"nodes":[],"edges":[]}',
          contentSha256: hashA,
          createdAt: timestamp,
        },
      },
      {
        protocol: STATION_API_PROTOCOL,
        op: "report",
        senderInstallationId: cc,
        targetInstallationId: remote,
        batch: requestBatch,
      },
      {
        protocol: STATION_API_PROTOCOL,
        op: "status",
      },
    ];

    expect(
      requests
        .map((candidate) => decodeStationControlRequest(candidate))
        .every(Either.isRight),
    ).toBe(true);
    expect(Schema.decodeUnknownSync(PairRequest)(requests[0])).toBeDefined();
    expect(
      Schema.decodeUnknownSync(ConfigureRequest)(requests[1]),
    ).toBeDefined();
    expect(Schema.decodeUnknownSync(ProjectRequest)(requests[2])).toBeDefined();
    const report = Schema.decodeUnknownSync(ReportRequest)(requests[3]);
    expect(Schema.decodeUnknownSync(StatusRequest)(requests[4])).toBeDefined();

    const response = Schema.decodeUnknownSync(ReportResponse)({
      protocol: STATION_API_PROTOCOL,
      op: "report",
      senderInstallationId: remote,
      targetInstallationId: cc,
      batch: responseBatch,
    });
    expect(reportResponseSwapsDirection(report, response)).toBe(true);

    expect(
      Schema.decodeUnknownSync(StatusResponse)({
        protocol: STATION_API_PROTOCOL,
        op: "status",
        installationId: remote,
        state: "ready",
        receivedThrough: [cursor(cc, remote, "1")],
        peerAcknowledgedThrough: [cursor(remote, remote, "2")],
        readiness: {
          database: true,
          workControl: true,
          simulation: true,
          session: true,
        },
        observedAt: timestamp,
      }),
    ).toBeDefined();
  });

  it("rejects v1 reports, opaque events, credentials, and sixth verbs", () => {
    expect(
      Either.isLeft(
        decodeStationControlRequest({
          protocol: "vellum/station-api/v1",
          op: "pair",
          commandCenterInstallationId: cc,
          stationInstallationId: remote,
          stationLabel: "Remote one",
          appVersion: "0.1.0",
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeStationControlRequest({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          stationInstallationId: remote,
          outbound: [
            {
              identity: {
                originInstallationId: remote,
                sequence: "1",
              },
              kind: "task",
              payload: {},
            },
          ],
          acknowledgeInbound: [],
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeStationControlRequest({
          protocol: STATION_API_PROTOCOL,
          op: "status",
          routeToken: "credentials-never-enter-the-domain",
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeStationControlRequest({
          protocol: STATION_API_PROTOCOL,
          op: "browser",
        }),
      ),
    ).toBe(true);

    expect("StationEvent" in StationApi).toBe(false);
    expect("StationEventIdentity" in StationApi).toBe(false);
    expect("StationEventAck" in StationApi).toBe(false);
  });

  it("bounds report records, acknowledgements, claims, and encoded bytes", () => {
    const records = Array.from(
      { length: STATION_API_MAX_RECORDS_PER_REPORT + 1 },
      (_, index) => messageFact(String(index + 1)),
    );
    expect(
      Either.isLeft(
        decodeStrict(ReportBatch)({
          records,
          acknowledge: [],
          hasMore: true,
        }),
      ),
    ).toBe(true);

    const acknowledge = Array.from(
      { length: STATION_API_MAX_ACKS_PER_REPORT + 1 },
      (_, index) => cursor(remote, remote, String(index + 1)),
    );
    expect(
      Either.isLeft(
        decodeStrict(ReportBatch)({
          records: [],
          acknowledge,
          hasMore: false,
        }),
      ),
    ).toBe(true);

    const claims = Array.from(
      {
        length: STATION_API_MAX_FIRST_DELIVERY_CLAIMS_PER_REPORT + 1,
      },
      (_, index) => claimCommand(String(index + 1)),
    );
    expect(
      decideReportBatchAdmission({
        records: claims,
        acknowledge: [],
        hasMore: true,
      }),
    ).toMatchObject({
      _tag: "first-delivery-claim-limit",
      actual: STATION_API_MAX_FIRST_DELIVERY_CLAIMS_PER_REPORT + 1,
    });
    expect(
      Either.isLeft(
        decodeStrict(ReportBatch)({
          records: claims,
          acknowledge: [],
          hasMore: true,
        }),
      ),
    ).toBe(true);

    const largeRecords = Array.from({ length: 35 }, (_, index) =>
      messageFact(String(index + 1), cc, "x".repeat(240 * 1024)),
    );
    const largeBatch = {
      records: largeRecords,
      acknowledge: [],
      hasMore: true,
    };
    expect(reportBatchEncodedByteLength(largeBatch)).toBeGreaterThan(
      STATION_API_MAX_REPORT_BATCH_BYTES,
    );
    expect(decideReportBatchAdmission(largeBatch)._tag).toBe(
      "encoded-byte-limit",
    );
    expect(Either.isLeft(decodeStrict(ReportBatch)(largeBatch))).toBe(true);
  });

  it("admits only records and acknowledgements with the exact direction", () => {
    expect(
      decideReportDirection({
        senderInstallationId: cc,
        targetInstallationId: remote,
        batch: requestBatch,
      }),
    ).toEqual({ _tag: "valid" });

    expect(
      decideReportDirection({
        senderInstallationId: cc,
        targetInstallationId: cc,
        batch: { records: [], acknowledge: [], hasMore: false },
      })._tag,
    ).toBe("same-installation");

    expect(
      decideReportDirection({
        senderInstallationId: remote,
        targetInstallationId: cc,
        batch: requestBatch,
      })._tag,
    ).toBe("record-event-home-mismatch");

    expect(
      decideReportDirection({
        senderInstallationId: cc,
        targetInstallationId: other,
        batch: requestBatch,
      })._tag,
    ).toBe("record-entity-home-mismatch");

    expect(
      decideReportDirection({
        senderInstallationId: cc,
        targetInstallationId: remote,
        batch: {
          records: [claimCommand()],
          acknowledge: [cursor(other, other, "1")],
          hasMore: false,
        },
      })._tag,
    ).toBe("acknowledgement-event-home-mismatch");

    expect(
      reportResponseSwapsDirection(
        {
          senderInstallationId: cc,
          targetInstallationId: remote,
        },
        {
          senderInstallationId: remote,
          targetInstallationId: other,
        },
      ),
    ).toBe(false);
  });

  it("uses absent cursor as zero and advances only full contiguous routes", () => {
    expect(
      Either.isLeft(
        decodeStrict(RouteCursor)({
          eventHome: cc,
          entityHome: remote,
          through: "0",
        }),
      ),
    ).toBe(true);

    const one = claimCommand("1");
    const two = claimCommand("2");
    const three = claimCommand("3");
    const four = claimCommand("4");
    const foreign = claimCommand("1", cc, other);
    const throughTwo = contiguousRouteCursor(
      one.id.route,
      undefined,
      [two.id, foreign.id, one.id, four.id],
    );
    expect(throughTwo?.through).toBe("2");
    const throughFour = contiguousRouteCursor(
      one.id.route,
      throughTwo,
      [four.id, three.id],
    );
    expect(throughFour?.through).toBe("4");
    expect(
      contiguousRouteCursor(one.id.route, undefined, [two.id]),
    ).toBeUndefined();

    const current = cursor(cc, remote, "2");
    expect(decideRouteCursorAdvance(undefined, current)._tag).toBe("advanced");
    expect(
      decideRouteCursorAdvance(current, cursor(cc, remote, "2"))._tag,
    ).toBe("idempotent");
    expect(
      decideRouteCursorAdvance(current, cursor(cc, remote, "1"))._tag,
    ).toBe("regression");
    expect(
      decideRouteCursorAdvance(current, cursor(cc, other, "3"))._tag,
    ).toBe("route-mismatch");
  });

  it("coalesces exact retries and rejects identity reuse with new content", () => {
    const admitted = claimCommand();
    expect(coalesceWorkRecords([admitted, admitted])).toEqual({
      _tag: "accepted",
      records: [admitted],
    });

    const conflict = decodeWorkRecord({
      ...admitted,
      contentSha256: hashC,
    });
    expect(coalesceWorkRecords([admitted, conflict])).toMatchObject({
      _tag: "identity-conflict",
      identity: admitted.id,
      admittedContentSha256: hashA,
      rejectedContentSha256: hashC,
    });
  });

  it("keeps configuration remote-only and host registrations exact", () => {
    const configure = {
      protocol: STATION_API_PROTOCOL,
      op: "configure",
      installationId: remote,
      configuration: {
        role: "remote",
        hostId: "remote-1",
        agentHostId: "remote-1",
        commandCenterInstallationId: cc,
        supervisedPreferred: true,
      },
      host: {
        id: "remote-1",
        label: "Remote one",
        kind: "remote",
        capabilities: ["terminal", "browser"],
      },
    };
    expect(Either.isRight(decodeStrict(ConfigureRequest)(configure))).toBe(
      true,
    );
    expect(
      Either.isLeft(
        decodeStrict(ConfigureRequest)({
          ...configure,
          configuration: {
            role: "command-center",
            hostId: "local",
            supervisedPreferred: true,
          },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeStrict(ConfigureRequest)({
          ...configure,
          host: {
            ...configure.host,
            capabilities: ["terminal", "terminal"],
          },
        }),
      ),
    ).toBe(true);
  });

  it("orders projections logically and rejects equal-generation conflicts", () => {
    const generationOne = Schema.decodeUnknownSync(LogicalSequence)("1");
    const generationTwo = Schema.decodeUnknownSync(LogicalSequence)("2");
    const current = Schema.decodeUnknownSync(StationProjectionReference)({
      generation: generationOne,
      contentSha256: hashA,
      receivedAt: timestamp,
    });
    const same = Schema.decodeUnknownSync(StationProjectionBody)({
      scope: "full",
      generation: generationOne,
      body: "{}",
      contentSha256: hashA,
      createdAt: timestamp,
    });
    const conflict = Schema.decodeUnknownSync(StationProjectionBody)({
      ...same,
      contentSha256: hashB,
    });
    const next = Schema.decodeUnknownSync(StationProjectionBody)({
      ...same,
      generation: generationTwo,
      contentSha256: hashB,
    });

    expect(compareLogicalSequence(generationOne, generationTwo)).toBe(-1);
    expect(decideProjectionInstall(undefined, same)).toBe("install");
    expect(decideProjectionInstall(current, same)).toBe("idempotent");
    expect(decideProjectionInstall(current, conflict)).toBe("conflict");
    expect(decideProjectionInstall(current, next)).toBe("install");
  });
});
