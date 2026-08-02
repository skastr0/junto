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
  basis: {
    kind: "command",
    command: commandId,
    commandSha256: hash,
  },
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
  basis: {
    kind: "projected-intent",
    generation: "9",
    contentSha256: "f".repeat(64),
  },
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
      task: {
        kind: "task",
        itemId: "task-1",
        sink,
      },
    },
    publishedBy: actor,
  },
};

describe("Work protocol v2 contract", () => {
  it("decodes InstallationId-based routes, claim records, and dispositions", () => {
    expect(Result.isSuccess(decodeWorkRecord(claimCommand))).toBe(true);
    expect(Result.isSuccess(decodeWorkRecord(claimFact))).toBe(true);
    expect(Result.isSuccess(decodeWorkRecord(appliedDisposition))).toBe(true);
    expect(Result.isSuccess(decodeWorkRecord(artifactFact))).toBe(true);

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
    const { basis: _basis, ...basisLessFact } = claimFact;
    expect(Result.isFailure(decodeWorkRecord(basisLessFact))).toBe(true);

    expect(
      Result.isSuccess(
        decodeWorkRecord({
          ...claimFact,
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
          ...claimFact,
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
          ...claimFact,
          basis: {
            kind: "command",
            command: {
              ...commandId,
              route: { eventHome: cc, entityHome: cc },
            },
            commandSha256: hash,
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...claimCommand,
          basis: claimFact.basis,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...appliedDisposition,
          basis: claimFact.basis,
        }),
      ),
    ).toBe(true);
  });

  it("keeps actions and results as closed discriminated sums", () => {
    expect(
      Result.isFailure(
        decodeWorkAction({
          operation: "task.assign",
          taskId: "task-1",
          actor,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkResult({
          operation: "task.assigned",
          task: sourceTask,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...claimCommand,
          operation: "task.transition",
        }),
      ),
    ).toBe(true);

    expect(
      Result.isSuccess(
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
      Result.isFailure(
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
      Result.isFailure(
        decodeWorkRecord({
          ...artifactFact,
          body: {
            operation: "artifact.publish",
            artifact: artifactFact.body.artifact,
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...artifactFact,
          body: {
            ...artifactFact.body,
            artifact: {
              artifactId: "artifact-1",
              parts: [{ kind: "text", text: "legacy reference" }],
              taskId: "task-1",
            },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...artifactFact,
          body: {
            ...artifactFact.body,
            artifact: {
              ...artifactFact.body.artifact,
              task: {
                ...artifactFact.body.artifact.task,
                kind: "request",
              },
            },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...artifactFact,
          body: {
            ...artifactFact.body,
            artifact: {
              ...artifactFact.body.artifact,
              task: {
                ...artifactFact.body.artifact.task,
                sink: {
                  ...artifactFact.body.artifact.task.sink,
                  canvasName: "other-canvas",
                },
              },
            },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeWorkRecord({
          ...artifactFact,
          body: {
            ...artifactFact.body,
            publishedBy: {
              ...artifactFact.body.publishedBy,
              canvasName: "other-canvas",
            },
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
      Result.isSuccess(
        decodeWorkAction({
          operation: "message.append",
          message: appendedMessage,
          sentBy: actor,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decodeWorkResult({
          operation: "message.append",
          message: appendedMessage,
          sentBy: actor,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeWorkAction({
          operation: "message.append",
          message: appendedMessage,
          destination: { kind: "mailbox" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
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
      Result.isSuccess(
        decodeWorkAction({
          operation: "message.append",
          message: taskMessage,
          sentBy: actor,
          destination: { kind: "task", itemId: "task-1" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeWorkAction({
          operation: "message.append",
          message: taskMessage,
          sentBy: actor,
          destination: { kind: "request", itemId: "request-1" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
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
      Result.isFailure(
        decodeWorkRecord({
          ...claimCommand,
          originStationId: cc,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
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
      Result.isFailure(
        decodeWorkRecord({
          ...claimCommand,
          predecessor: claimCommand.body.sourcePredecessor,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
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
      Result.isFailure(
        decodeWorkRecord({
          ...claimFact,
          predecessor: factId,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
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
      Result.isFailure(
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
      Result.isFailure(
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
    expect(Result.isSuccess(decodeWorkRecord(taskCreateFact))).toBe(true);
    expect(
      Result.isFailure(
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
      Result.isFailure(
        decodeWorkRecord({
          ...claimFact,
          receivedAt: timestamp,
        }),
      ),
    ).toBe(true);

    expect(
      Result.isSuccess(
        decodeStoredWorkRecord({
          record: claimFact,
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
    expect(Result.isFailure(decodeWorkRecord(oversized))).toBe(true);
  });
});
