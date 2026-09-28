import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  RouteCursor,
  WORK_PROTOCOL,
  WORK_PROTOCOL_MAX_RECORD_BYTES,
  decodeStoredWorkRecord,
  decodeWorkAction,
  decodeWorkRecord,
  decodeWorkResult,
  workRecordEncodedByteLength,
} from "../src/shared/work-protocol";

const cc = "cc-installation";
const remote = "remote-installation";
const timestamp = "2026-07-27T18:00:00.000Z";
const hash = "a".repeat(64);
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

const mail = {
  messageId: "message-1",
  role: "agent" as const,
  parts: [{ kind: "text" as const, text: "sent from this seat" }],
};

const item = {
  kind: "message",
  itemId: mail.messageId,
  sink,
};

// Mail is resident on the Command Center: a Remote seat's message travels
// as a command routed to the Command Center, which answers with the fact and
// an applied disposition.
const commandId = {
  route: {
    eventHome: remote,
    entityHome: cc,
  },
  seq: "1",
};

const factId = {
  route: {
    eventHome: cc,
    entityHome: cc,
  },
  seq: "1",
};

const messageBody = {
  operation: "message.append",
  message: mail,
  sentBy: actor,
  destination: { kind: "mailbox" },
};

const messageCommand = {
  protocol: WORK_PROTOCOL,
  id: commandId,
  recordType: "command",
  item,
  operation: "message.append",
  contentSha256: hash,
  originAt: timestamp,
  predecessor: null,
  body: messageBody,
};

const messageFact = {
  protocol: WORK_PROTOCOL,
  id: factId,
  recordType: "fact",
  basis: {
    kind: "command",
    command: commandId,
    commandSha256: hash,
  },
  item,
  operation: "message.append",
  contentSha256: "b".repeat(64),
  originAt: timestamp,
  predecessor: null,
  body: messageBody,
};

const appliedDisposition = {
  protocol: WORK_PROTOCOL,
  id: {
    route: {
      eventHome: cc,
      entityHome: cc,
    },
    seq: "2",
  },
  recordType: "disposition",
  item,
  operation: "message.append",
  contentSha256: "c".repeat(64),
  originAt: timestamp,
  body: {
    status: "applied",
    command: commandId,
    commandSha256: hash,
    fact: factId,
    factSha256: "b".repeat(64),
  },
};

describe("Work protocol v2 contract", () => {
  it("decodes InstallationId-based routes, mail records, and dispositions", () => {
    expect(Result.isSuccess(decodeWorkRecord(messageCommand))).toBe(true);
    expect(Result.isSuccess(decodeWorkRecord(messageFact))).toBe(true);
    expect(Result.isSuccess(decodeWorkRecord(appliedDisposition))).toBe(true);

    const cursor = Schema.decodeUnknownResult(RouteCursor, {
      onExcessProperty: "error",
    })({
      eventHome: remote,
      entityHome: remote,
      through: "9007199254740993",
    });
    expect(Result.isSuccess(cursor)).toBe(true);

    // No cursor represents "nothing received"; zero is not a record sequence.
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(RouteCursor, {
          onExcessProperty: "error",
        })({
          eventHome: remote,
          entityHome: remote,
          through: "0",
        }),
      ),
    ).toBe(true);
  });

  it("requires one strict fact basis and keeps it off commands and dispositions", () => {
    const { basis: _basis, ...basisLessFact } = messageFact;
    expect(Result.isFailure(decodeWorkRecord(basisLessFact))).toBe(true);

    expect(
      Result.isSuccess(
        decodeWorkRecord({
          ...messageFact,
          basis: {
            kind: "authorial-intent",
            generation: "11",
            contentSha256: "1".repeat(64),
          },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decodeWorkRecord({
          ...messageFact,
          basis: {
            kind: "projected-intent",
            generation: "11",
            contentSha256: "2".repeat(64),
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...messageCommand,
          basis: messageFact.basis,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...appliedDisposition,
          basis: messageFact.basis,
        }),
      ),
    ).toBe(true);
  });

  it("keeps actions and results as closed discriminated sums", () => {
    expect(
      Result.isFailure(
        decodeWorkAction({
          operation: "message.invalid",
          message: mail,
          sentBy: actor,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkResult({
          operation: "message.unknown",
          message: mail,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isSuccess(
        decodeWorkAction({
          operation: "message.append",
          message: mail,
          sentBy: actor,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decodeWorkResult({
          operation: "message.append",
          message: mail,
          sentBy: actor,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    // Mail always names who sent it.
    expect(
      Result.isFailure(
        decodeWorkAction({
          operation: "message.append",
          message: mail,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeWorkResult({
          operation: "message.append",
          message: mail,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    // And where it goes.
    expect(
      Result.isFailure(
        decodeWorkAction({
          operation: "message.append",
          message: mail,
          sentBy: actor,
        }),
      ),
    ).toBe(true);
  });

  it("rejects excess properties at every decoded boundary", () => {
    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...messageCommand,
          originStationId: cc,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...messageCommand,
          body: {
            ...messageCommand.body,
            sentBy: {
              ...actor,
              hostId: "legacy-placement-authority",
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps receivedAt local to StoredWorkRecord", () => {
    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...messageFact,
          receivedAt: timestamp,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isSuccess(
        decodeStoredWorkRecord({
          record: messageFact,
          receivedAt: timestamp,
        }),
      ),
    ).toBe(true);
  });

  it("rejects unknown disposition reasons", () => {
    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...appliedDisposition,
          body: {
            status: "rejected",
            command: commandId,
            commandSha256: hash,
            reason: "remote-was-slow",
            message: "Not a protocol reason",
          },
        }),
      ),
    ).toBe(true);

    // Referenced command/fact semantic coherence is loaded and checked by the
    // repository; the seam still makes malformed reference hashes impossible.
    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...appliedDisposition,
          body: {
            ...appliedDisposition.body,
            commandSha256: "not-a-sha256",
          },
        }),
      ),
    ).toBe(true);
  });

  it("applies an intrinsic record bound independent of ReportBatch", () => {
    const oversized = {
      ...messageCommand,
      body: {
        ...messageCommand.body,
        message: {
          ...mail,
          parts: [
            { kind: "text", text: "x".repeat(WORK_PROTOCOL_MAX_RECORD_BYTES) },
          ],
        },
      },
    };

    expect(workRecordEncodedByteLength(messageCommand)).toBeLessThan(
      WORK_PROTOCOL_MAX_RECORD_BYTES,
    );
    expect(Result.isFailure(decodeWorkRecord(oversized))).toBe(true);
  });
});
