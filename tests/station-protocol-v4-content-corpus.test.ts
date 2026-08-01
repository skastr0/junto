import { readFileSync } from "node:fs";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ContentAvailability,
  ContentRef,
  taskContentIsRunnable,
  taskContentReadiness,
} from "../src/shared/content";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  negotiateStationProtocol,
  selectStationProtocolCodec,
  StationProtocolSupport,
} from "../src/shared/station-protocol";
import {
  decodeWorkRecord,
  workRecordEncodedByteLength,
  WORK_PROTOCOL_MAX_RECORD_BYTES,
} from "../src/shared/work-protocol";
import type { Task } from "../src/shared/work-model";

interface ContentWireCorpus {
  readonly protocol: {
    readonly baseline: number;
    readonly support: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
    readonly retired: ReadonlyArray<number>;
    readonly noCommonWithProtocol3: {
      readonly local: {
        readonly preferred: number;
        readonly compatibleFrom: number;
        readonly warnBelow: number;
      };
      readonly peer: {
        readonly preferred: number;
        readonly compatibleFrom: number;
        readonly warnBelow: number;
      };
      readonly outcome: string;
    };
  };
  readonly ordering: ReadonlyArray<string>;
  readonly ref: unknown;
  readonly cases: Record<
    string,
    {
      readonly availability: unknown;
      readonly runnable: boolean;
    }
  >;
  readonly taskCreateFact: unknown;
  readonly inlineBinaryDownConvertRejected: unknown;
}

const corpus = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/station-protocol-v4/content-wire-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ContentWireCorpus;

const support = (value: {
  readonly preferred: number;
  readonly compatibleFrom: number;
  readonly warnBelow: number;
}) => Schema.decodeUnknownSync(StationProtocolSupport)(value);

const taskWithRef = (ref: ContentRef): Task => ({
  id: "task-media-1",
  state: "submitted",
  history: [
    {
      messageId: "msg-1",
      role: "user",
      parts: [
        { kind: "text", text: "Review this recording" },
        { kind: "content", ref },
      ],
      taskId: "task-media-1",
      contextId: "Vellumcommand",
    },
  ],
});

describe("Station protocol 4 content wire corpus", () => {
  it("installs only the content-capable protocol-4 codec", () => {
    expect(STATION_PROTOCOL_BASELINE).toBe(4);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual(corpus.protocol.support);
    expect(selectStationProtocolCodec(4)).toEqual(Either.right(4));
    for (const retired of corpus.protocol.retired) {
      expect(selectStationProtocolCodec(retired)).toEqual(
        Either.left("unsupported-station-protocol"),
      );
    }
  });

  it("returns update-required (no-common) against protocol-3 peers without down-conversion", () => {
    const negotiation = negotiateStationProtocol(
      support(corpus.protocol.noCommonWithProtocol3.local),
      support(corpus.protocol.noCommonWithProtocol3.peer),
    );
    expect(negotiation).toMatchObject({ _tag: "no-common" });
    expect(corpus.protocol.noCommonWithProtocol3.outcome).toBe(
      "update-required",
    );
  });

  it("defines the projection → transfer → receipt → claim → ack ordering", () => {
    expect(corpus.ordering).toEqual([
      "project-authorial-canvas",
      "report-work-with-content-refs",
      "transfer-bytes-out-of-band",
      "verify-and-mint-receipt",
      "claim-and-execute-task",
      "acknowledge-work-records",
    ]);
  });

  it("admits ContentRef task facts and keeps them under the control-record bound", () => {
    const decoded = decodeWorkRecord(corpus.taskCreateFact);
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;
    const bytes = workRecordEncodedByteLength(decoded.right);
    expect(bytes).toBeDefined();
    expect(bytes!).toBeLessThan(WORK_PROTOCOL_MAX_RECORD_BYTES);
    expect(bytes!).toBeLessThan(8_192);
  });

  it("rejects Base64 down-conversion of media on the Work wire", () => {
    expect(
      Either.isLeft(decodeWorkRecord(corpus.inlineBinaryDownConvertRejected)),
    ).toBe(true);
  });

  it.each([
    "content-present",
    "content-missing",
    "retry",
    "corrupt",
  ] as const)("gates runnable work for %s", (name) => {
    const sample = corpus.cases[name]!;
    const availability = Schema.decodeUnknownSync(ContentAvailability)(
      sample.availability,
    );
    const ref = Schema.decodeUnknownSync(ContentRef)(corpus.ref);
    const task = taskWithRef(ref);
    const resolve = () => availability;
    expect(taskContentIsRunnable(task, resolve)).toBe(sample.runnable);
    const readiness = taskContentReadiness(task, resolve);
    if (sample.runnable) {
      expect(readiness.kind).toBe("ready");
    } else {
      expect(readiness.kind).toBe("pending");
    }
  });
});
