import { Either, Schema } from "effect";
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

const commandId = {
  route: {
    eventHome: cc,
    entityHome: remote,
  },
  seq: "1",
};

const factId = {
  route: {
    eventHome: remote,
    entityHome: remote,
  },
  seq: "1",
};

const claimCommand = {
  protocol: WORK_PROTOCOL,
  id: commandId,
  recordType: "command",
  item: {
    kind: "task",
    itemId: sourceTask.id,
    sink,
  },
  operation: "task.claim",
  contentSha256: hash,
  originAt: timestamp,
  predecessor: null,
  body: {
    operation: "task.claim",
    sourceQueueHome: cc,
    sourcePredecessor: {
      route: {
        eventHome: cc,
        entityHome: cc,
      },
      seq: "9",
    },
    sourceTask,
    sink,
    actor,
    targetHome: remote,
  },
};

const claimFact = {
  protocol: WORK_PROTOCOL,
  id: factId,
  recordType: "fact",
  item: {
    kind: "task",
    itemId: sourceTask.id,
    sink,
  },
  operation: "task.claim",
  contentSha256: "b".repeat(64),
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
    previousHome: cc,
  },
};

const appliedDisposition = {
  protocol: WORK_PROTOCOL,
  id: {
    route: {
      eventHome: remote,
      entityHome: remote,
    },
    seq: "2",
  },
  recordType: "disposition",
  item: {
    kind: "task",
    itemId: sourceTask.id,
    sink,
  },
  operation: "task.claim",
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

const artifactFact = {
  protocol: WORK_PROTOCOL,
  id: {
    route: {
      eventHome: remote,
      entityHome: remote,
    },
    seq: "3",
  },
  recordType: "fact",
  item: {
    kind: "artifact",
    itemId: "artifact-1",
    sink: {
      canvasName: "factory",
      nodeId: "artifacts",
    },
  },
  operation: "artifact.publish",
  contentSha256: "e".repeat(64),
  originAt: timestamp,
  predecessor: null,
  body: {
    operation: "artifact.publish",
    artifact: {
      artifactId: "artifact-1",
      parts: [{ kind: "text", text: "release receipt" }],
    },
    publishedBy: actor,
  },
};

describe("Work protocol v2 contract", () => {
  it("decodes InstallationId-based routes, claim records, and dispositions", () => {
    expect(Either.isRight(decodeWorkRecord(claimCommand))).toBe(true);
    expect(Either.isRight(decodeWorkRecord(claimFact))).toBe(true);
    expect(Either.isRight(decodeWorkRecord(appliedDisposition))).toBe(true);
    expect(Either.isRight(decodeWorkRecord(artifactFact))).toBe(true);

    const cursor = Schema.decodeUnknownEither(RouteCursor, {
      onExcessProperty: "error",
    })({
      eventHome: remote,
      entityHome: remote,
      through: "9007199254740993",
    });
    expect(Either.isRight(cursor)).toBe(true);

    // No cursor represents "nothing received"; zero is not a record sequence.
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(RouteCursor, {
          onExcessProperty: "error",
        })({
          eventHome: remote,
          entityHome: remote,
          through: "0",
        }),
      ),
    ).toBe(true);
  });

  it("keeps actions and results as closed discriminated sums", () => {
    expect(
      Either.isLeft(
        decodeWorkAction({
          operation: "task.assign",
          taskId: "task-1",
          actor,
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkResult({
          operation: "task.assigned",
          task: sourceTask,
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimCommand,
          operation: "task.transition",
        }),
      ),
    ).toBe(true);

    expect(
      Either.isRight(
        decodeWorkResult({
          operation: "request.resolve",
          request: {
            id: "request-1",
            state: "completed",
            claimedBy: seatId,
            history: [],
          },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeWorkResult({
          operation: "request.resolve",
          request: {
            id: "request-1",
            state: "completed",
            history: [],
          },
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...artifactFact,
          body: {
            operation: "artifact.publish",
            artifact: artifactFact.body.artifact,
          },
        }),
      ),
    ).toBe(true);

    const appendedMessage = {
      messageId: "message-provenance",
      role: "agent" as const,
      parts: [{ kind: "text" as const, text: "sent from this seat" }],
    };
    expect(
      Either.isRight(
        decodeWorkAction({
          operation: "message.append",
          message: appendedMessage,
          sentBy: actor,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isRight(
        decodeWorkResult({
          operation: "message.append",
          message: appendedMessage,
          sentBy: actor,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeWorkAction({
          operation: "message.append",
          message: appendedMessage,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeWorkResult({
          operation: "message.append",
          message: appendedMessage,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);

    const taskMessage = {
      ...appendedMessage,
      taskId: "task-1",
    };
    expect(
      Either.isRight(
        decodeWorkAction({
          operation: "message.append",
          message: taskMessage,
          sentBy: actor,
          destination: { kind: "task", itemId: "task-1" },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeWorkAction({
          operation: "message.append",
          message: taskMessage,
          sentBy: actor,
          destination: { kind: "request", itemId: "request-1" },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeWorkAction({
          operation: "message.append",
          message: taskMessage,
          sentBy: actor,
        }),
      ),
    ).toBe(true);
  });

  it("rejects excess properties at every decoded boundary", () => {
    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimCommand,
          originStationId: cc,
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimCommand,
          body: {
            ...claimCommand.body,
            actor: {
              ...actor,
              hostId: "legacy-placement-authority",
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("enforces the first-adoption predecessor laws", () => {
    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimCommand,
          predecessor: claimCommand.body.sourcePredecessor,
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimCommand,
          body: {
            ...claimCommand.body,
            sourcePredecessor: {
              route: {
                eventHome: cc,
                entityHome: remote,
              },
              seq: "9",
            },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimFact,
          predecessor: factId,
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimFact,
          body: {
            ...claimFact.body,
            previousHome: remote,
          },
        }),
      ),
    ).toBe(true);
  });

  it("makes claimant identity first-class and exact", () => {
    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimCommand,
          body: {
            ...claimCommand.body,
            sourceTask: {
              ...sourceTask,
              metadata: {
                claimedBy: seatId,
              },
            },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimFact,
          body: {
            ...claimFact.body,
            task: {
              ...claimFact.body.task,
              claimedBy: `seat_${"e".repeat(64)}`,
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("admits only submitted unclaimed task.create facts", () => {
    const taskCreateFact = {
      ...claimFact,
      operation: "task.create",
      predecessor: null,
      body: {
        operation: "task.create",
        task: sourceTask,
      },
    };
    expect(Either.isRight(decodeWorkRecord(taskCreateFact))).toBe(true);
    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...taskCreateFact,
          body: {
            operation: "task.create",
            task: {
              ...sourceTask,
              state: "completed",
              claimedBy: actor.seatId,
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps receivedAt local to StoredWorkRecord", () => {
    expect(
      Either.isLeft(
        decodeWorkRecord({
          ...claimFact,
          receivedAt: timestamp,
        }),
      ),
    ).toBe(true);

    expect(
      Either.isRight(
        decodeStoredWorkRecord({
          record: claimFact,
          receivedAt: timestamp,
        }),
      ),
    ).toBe(true);
  });

  it("rejects unknown disposition reasons", () => {
    expect(
      Either.isLeft(
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
      Either.isLeft(
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
      ...claimCommand,
      body: {
        ...claimCommand.body,
        sourceTask: {
          ...sourceTask,
          metadata: {
            oversized: "x".repeat(WORK_PROTOCOL_MAX_RECORD_BYTES),
          },
        },
      },
    };

    expect(workRecordEncodedByteLength(claimCommand)).toBeLessThan(
      WORK_PROTOCOL_MAX_RECORD_BYTES,
    );
    expect(Either.isLeft(decodeWorkRecord(oversized))).toBe(true);
  });
});
