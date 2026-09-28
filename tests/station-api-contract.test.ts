import { Result, Schema } from "effect";
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
  STATION_API_MAX_COMMANDS_PER_REPORT,
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
  <S extends Schema.Top>(schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(value);

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
  nodeId: "recipient",
};

const actor = {
  seatId,
  canvasName: "factory",
  nodeId: "builder",
};

const decodeWorkRecord = Schema.decodeUnknownSync(WorkRecord, {
  onExcessProperty: "error",
});

const mailBody = (messageId: string) => ({
  operation: "message.append",
  message: {
    messageId,
    role: "agent",
    parts: [{ kind: "text", text: "hello from the Remote" }],
  },
  sentBy: actor,
  destination: { kind: "mailbox" },
});

/** A Remote seat's mail, routed to the Command Center that holds mailboxes. */
const mailCommand = (
  seq = "1",
  sender = remote,
  target = cc,
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
      kind: "message",
      itemId: `mail-${seq}`,
      sink,
    },
    operation: "message.append",
    contentSha256: hashA,
    originAt: timestamp,
    predecessor: null,
    body: mailBody(`mail-${seq}`),
  });

/** The Command Center's fact answering that command. */
const mailAnswer = (
  seq = "1",
  sender = cc,
  commandHome = remote,
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
      itemId: "mail-1",
      sink,
    },
    operation: "message.append",
    contentSha256: hashB,
    originAt: timestamp,
    basis: {
      kind: "command",
      command: {
        route: {
          eventHome: commandHome,
          entityHome: sender,
        },
        seq: "1",
      },
      commandSha256: hashA,
    },
    predecessor: null,
    body: mailBody("mail-1"),
  });

const appliedDisposition = (
  seq = "2",
  sender = cc,
  command = mailCommand(),
  fact = mailAnswer(),
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
    operation: "message.append",
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
    basis: {
      kind: "authorial-intent",
      generation: "1",
      contentSha256: hashB,
    },
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
  records: [mailCommand()],
  acknowledge: [cursor(cc, cc, "2")],
  hasMore: false,
};

const responseBatch = {
  records: [mailAnswer(), appliedDisposition()],
  acknowledge: [cursor(remote, cc, "1")],
  hasMore: false,
};

describe("Station API v1 contract", () => {
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
          sourceCanvasGeneration: "1",
          sourceIntentSha256: hashA,
          body: '{"nodes":[],"edges":[]}',
          contentSha256: hashA,
          createdAt: timestamp,
        },
      },
      {
        protocol: STATION_API_PROTOCOL,
        op: "report",
        senderInstallationId: remote,
        targetInstallationId: cc,
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
        .every(Result.isSuccess),
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
      senderInstallationId: cc,
      targetInstallationId: remote,
      batch: responseBatch,
    });
    expect(reportResponseSwapsDirection(report, response)).toBe(true);

    expect(
      Schema.decodeUnknownSync(StatusResponse)({
        protocol: STATION_API_PROTOCOL,
        op: "status",
        installationId: remote,
        state: "ready",
        receivedThrough: [cursor(cc, cc, "2")],
        peerAcknowledgedThrough: [cursor(remote, cc, "1")],
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

  it("rejects non-v1 frames, opaque events, excess fields, and sixth verbs", () => {
    expect(
      Result.isFailure(
        decodeStationControlRequest({
          protocol: "junto/station-api/v2",
          op: "pair",
          commandCenterInstallationId: cc,
          stationInstallationId: remote,
          stationLabel: "Remote one",
          appVersion: "0.1.0",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
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
              kind: "message",
              payload: {},
            },
          ],
          acknowledgeInbound: [],
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeStationControlRequest({
          protocol: STATION_API_PROTOCOL,
          op: "status",
          extra: "strict-decode",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
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

  it("bounds report records, response-producing commands, acknowledgements, and encoded bytes", () => {
    const records = Array.from(
      { length: STATION_API_MAX_RECORDS_PER_REPORT + 1 },
      (_, index) => messageFact(String(index + 1)),
    );
    expect(
      Result.isFailure(
        decodeStrict(ReportBatch)({
          records,
          acknowledge: [],
          hasMore: true,
        }),
      ),
    ).toBe(true);

    expect(STATION_API_MAX_COMMANDS_PER_REPORT * 2).toBeLessThanOrEqual(
      STATION_API_MAX_RECORDS_PER_REPORT,
    );
    expect((STATION_API_MAX_COMMANDS_PER_REPORT + 1) * 2).toBeGreaterThan(
      STATION_API_MAX_RECORDS_PER_REPORT,
    );
    const commands = Array.from(
      { length: STATION_API_MAX_COMMANDS_PER_REPORT + 1 },
      (_, index) => mailCommand(String(index + 1)),
    );
    expect(
      decideReportBatchAdmission({
        records: commands,
        acknowledge: [],
        hasMore: true,
      }),
    ).toMatchObject({
      _tag: "command-response-capacity-limit",
      actual: STATION_API_MAX_COMMANDS_PER_REPORT + 1,
      limit: STATION_API_MAX_COMMANDS_PER_REPORT,
    });
    expect(
      Result.isFailure(
        decodeStrict(ReportBatch)({
          records: commands,
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
      Result.isFailure(
        decodeStrict(ReportBatch)({
          records: [],
          acknowledge,
          hasMore: false,
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
    expect(Result.isFailure(decodeStrict(ReportBatch)(largeBatch))).toBe(true);
  });

  it("admits only records and acknowledgements with the exact direction", () => {
    expect(
      decideReportDirection({
        senderInstallationId: remote,
        targetInstallationId: cc,
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
        senderInstallationId: cc,
        targetInstallationId: remote,
        batch: requestBatch,
      })._tag,
    ).toBe("record-event-home-mismatch");

    expect(
      decideReportDirection({
        senderInstallationId: remote,
        targetInstallationId: other,
        batch: requestBatch,
      })._tag,
    ).toBe("record-entity-home-mismatch");

    expect(
      decideReportDirection({
        senderInstallationId: remote,
        targetInstallationId: cc,
        batch: {
          records: [mailCommand()],
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
      Result.isFailure(
        decodeStrict(RouteCursor)({
          eventHome: cc,
          entityHome: remote,
          through: "0",
        }),
      ),
    ).toBe(true);

    const one = mailCommand("1");
    const two = mailCommand("2");
    const three = mailCommand("3");
    const four = mailCommand("4");
    const foreign = mailCommand("1", remote, other);
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
    const admitted = mailCommand();
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
    expect(Result.isSuccess(decodeStrict(ConfigureRequest)(configure))).toBe(
      true,
    );
    expect(
      Result.isFailure(
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
      Result.isFailure(
        decodeStrict(ConfigureRequest)({
          ...configure,
          host: {
            ...configure.host,
            capabilities: ["terminal", "terminal"],
          },
        }),
      ),
    ).toBe(true);
    for (const [retiredRouteField, retiredRouteValue] of [
      ["sshEndpoint", "remote-alias"],
      ["sshIdentityFile", "/tmp/id_ed25519"],
      ["sshHostKeyPolicy", "accept-new"],
    ] as const) {
      expect(
        Result.isFailure(
          decodeStrict(ConfigureRequest)({
            ...configure,
            host: {
              ...configure.host,
              [retiredRouteField]: retiredRouteValue,
            },
          }),
        ),
      ).toBe(true);
    }
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
      sourceCanvasGeneration: generationOne,
      sourceIntentSha256: hashA,
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
