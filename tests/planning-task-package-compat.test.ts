import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { renderSchemaContract, tasksCreateSchema } from "../src/cli/core/discovery";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";
import { evaluateSchemaCompatibility } from "../src/main/vellum/state/schema-version-probe";
import { ActorSeatId } from "../src/shared/actor-seat";
import { STATION_CONTROL_PROTOCOL } from "../src/shared/station-api-envelope";
import { STATION_API_PROTOCOL } from "../src/shared/station-api";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  selectStationProtocolCodec,
} from "../src/shared/station-protocol";
import { STATION_SESSION_PROTOCOL } from "../src/shared/station-session";
import {
  CompletionEvidence,
  FinishCriteria,
  Message,
  Passage,
  TaskClaim,
  TaskDefect,
  TaskState,
  Ticket,
  WorkMetadata,
} from "../src/shared/work-model";
import {
  DisplayTimestamp,
  FactBasis,
  WORK_PROTOCOL,
  WorkItemRef,
  WorkRecordId,
  WorkSha256,
  decodeWorkRecord,
} from "../src/shared/work-protocol";

type PackagePairCorpus = {
  readonly contract: string;
  readonly olderPublicPackage: {
    readonly tasksCreateSchemaId: string;
    readonly stateSchemaVersion: number;
    readonly taskCreateSemantics: string;
  };
  readonly candidatePackage: {
    readonly tasksCreateSchemaId: string;
    readonly stateSchemaVersion: number;
    readonly taskCreateSemantics: string;
  };
  readonly unreleasedSameSchemaIntermediate: {
    readonly stateSchemaVersion: number;
    readonly readsTaskAdmissionMetadata: boolean;
    readonly provenance: string;
  };
  readonly station: {
    readonly baseline: number;
    readonly support: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
    readonly session: string;
    readonly api: string;
    readonly control: string;
    readonly work: string;
  };
};

type TaskCreateFactSample = Record<string, unknown> & {
  readonly body: {
    readonly operation: "task.create";
    readonly task: Record<string, unknown>;
  };
};

const packagePair = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/planning-task-package-compat/package-pair.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PackagePairCorpus;

const stationV1Corpus = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/station-protocol-v1/content-wire-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly taskCreateFact: TaskCreateFactSample };

/**
 * Structural Task contract used by the tasks.create.input/v2 package before
 * the candidate added Task.admission and Task.raisedBy. This is deliberately
 * test-local: it characterizes the older strict package without adding a
 * second runtime codec or changing Station protocol 1.
 */
const FrozenV2Task = Schema.Struct({
  id: Schema.String,
  state: TaskState,
  claimedBy: Schema.optionalKey(ActorSeatId),
  history: Schema.Array(Message),
  artifactIds: Schema.optionalKey(Schema.Array(Schema.String)),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  finishCriteria: Schema.optionalKey(FinishCriteria),
  claims: Schema.optionalKey(Schema.Array(TaskClaim)),
  completionEvidence: Schema.optionalKey(CompletionEvidence),
  epoch: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  journey: Schema.optionalKey(Schema.Array(Passage)),
  defects: Schema.optionalKey(Schema.Array(TaskDefect)),
  holdUntil: Schema.optionalKey(Schema.String),
  boarding: Schema.optionalKey(Schema.Array(Ticket)),
  metadata: Schema.optionalKey(WorkMetadata),
  reason: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(Schema.String),
});

const FrozenV2TaskCreateFact = Schema.Struct({
  protocol: Schema.Literal(WORK_PROTOCOL),
  id: WorkRecordId,
  recordType: Schema.Literal("fact"),
  item: WorkItemRef,
  operation: Schema.Literal("task.create"),
  contentSha256: WorkSha256,
  originAt: DisplayTimestamp,
  basis: FactBasis,
  predecessor: Schema.NullOr(WorkRecordId),
  body: Schema.Struct({
    operation: Schema.Literal("task.create"),
    task: FrozenV2Task,
  }),
});

const decodeFrozenV2TaskCreateFact = Schema.decodeUnknownResult(
  FrozenV2TaskCreateFact,
  { onExcessProperty: "error" },
);

const currentTaskCreateFact = (): TaskCreateFactSample => {
  const record = structuredClone(stationV1Corpus.taskCreateFact);
  record.body.task.admission = "operator-gated";
  record.body.task.raisedBy = {
    seatId: `seat_${"c".repeat(64)}`,
    canvasName: "factory",
    nodeId: "operator",
  };
  return record;
};

describe("planning Task mixed-package characterization", () => {
  it("pins the tasks.create v2 to v3 semantic boundary", () => {
    expect(packagePair.contract).toBe(
      "vellum-command/planning-task-package-characterization/v1",
    );
    expect(packagePair.olderPublicPackage).toMatchObject({
      tasksCreateSchemaId: "tasks.create.input/v2",
      stateSchemaVersion: 18,
      taskCreateSemantics: "pending-proposal-mints-new-task-on-approval",
    });

    const candidate = renderSchemaContract(tasksCreateSchema);
    expect(candidate.schema_id).toBe(
      packagePair.candidatePackage.tasksCreateSchemaId,
    );
    expect(packagePair.candidatePackage).toMatchObject({
      tasksCreateSchemaId: "tasks.create.input/v3",
      stateSchemaVersion: 20,
      taskCreateSemantics: "stable-task-id-with-operator-gated-admission",
    });
    expect(candidate.schema).toMatchObject({
      properties: {
        admission: {
          type: "string",
          enum: ["auto", "operator-gated", "operator-owned"],
        },
        holdFor: {},
      },
    });
  });

  it("keeps the exact protocol 1 bundle and its legacy task.create corpus unchanged", () => {
    expect(STATION_PROTOCOL_BASELINE).toBe(packagePair.station.baseline);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual(
      packagePair.station.support,
    );
    expect(selectStationProtocolCodec(1)).toEqual(Result.succeed(1));
    expect(selectStationProtocolCodec(2)).toEqual(
      Result.fail("unsupported-station-protocol"),
    );
    expect({
      session: STATION_SESSION_PROTOCOL,
      api: STATION_API_PROTOCOL,
      control: STATION_CONTROL_PROTOCOL,
      work: WORK_PROTOCOL,
    }).toEqual({
      session: packagePair.station.session,
      api: packagePair.station.api,
      control: packagePair.station.control,
      work: packagePair.station.work,
    });

    expect(
      createHash("sha256")
        .update(JSON.stringify(stationV1Corpus.taskCreateFact), "utf8")
        .digest("hex"),
    ).toBe("23af8b52d7562d493180e202110924e5d56b2b00f360a18a7bdb31255b63fcd0");
    expect(Result.isSuccess(decodeWorkRecord(stationV1Corpus.taskCreateFact))).toBe(
      true,
    );
    expect(
      Result.isSuccess(
        decodeFrozenV2TaskCreateFact(stationV1Corpus.taskCreateFact),
      ),
    ).toBe(true);
  });

  it("characterizes new-read-old success and older strict rejection of admission metadata", () => {
    const record = currentTaskCreateFact();

    const current = decodeWorkRecord(record);
    expect(Result.isSuccess(current)).toBe(true);
    if (
      Result.isSuccess(current) &&
      current.success.recordType === "fact" &&
      current.success.body.operation === "task.create"
    ) {
      expect(current.success.body.task).toMatchObject({
        admission: "operator-gated",
        raisedBy: {
          canvasName: "factory",
          nodeId: "operator",
        },
      });
    }

    const older = decodeFrozenV2TaskCreateFact(record);
    expect(Result.isFailure(older)).toBe(true);
    if (Result.isFailure(older)) {
      expect(String(older.failure)).toMatch(/admission|raisedBy/u);
    }

    // The integer and namespaces did not negotiate this shape change. The
    // Remote-home containment test proves this task path refuses before it can
    // enqueue this candidate-only Task shape onto protocol 1.
    expect(selectStationProtocolCodec(1)).toEqual(Result.succeed(1));
    expect(record.protocol).toBe(WORK_PROTOCOL);
  });

  it("rejects the supported public schema-18 binary before it can read schema-20 state", () => {
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(
      packagePair.candidatePackage.stateSchemaVersion,
    );
    const currentState = {
      kind: "present" as const,
      userVersion: CURRENT_STATE_SCHEMA_VERSION,
      path: "/state/vellum-command.db",
    };

    expect(
      evaluateSchemaCompatibility(
        currentState,
        packagePair.olderPublicPackage.stateSchemaVersion,
      ),
    ).toEqual({
      ok: false,
      reason: "newer-than-supported",
      userVersion: 20,
      supportedVersion: 18,
      path: "/state/vellum-command.db",
    });

    // Some unreleased intermediate builds also reported schema 20 but did not
    // lift the admission metadata. Equal user_version cannot distinguish that
    // unsupported provenance, so it is not a qualified package-pair path.
    expect(packagePair.unreleasedSameSchemaIntermediate).toEqual({
      stateSchemaVersion: 20,
      readsTaskAdmissionMetadata: false,
      provenance: "unreleased-unsupported",
    });
    expect(
      evaluateSchemaCompatibility(
        currentState,
        packagePair.unreleasedSameSchemaIntermediate.stateSchemaVersion,
      ),
    ).toEqual({ ok: true, userVersion: 20 });
  });
});
