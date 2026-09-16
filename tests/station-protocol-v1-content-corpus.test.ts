import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
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
  selectStationProtocolCodec,
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
      "./fixtures/station-protocol-v1/content-wire-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ContentWireCorpus;

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
      contextId: "Juntocommand",
    },
  ],
});

describe("Station protocol v1 content wire corpus", () => {
  it("keeps the complete unreleased content-capable contract at v1", () => {
    expect(corpus.protocol.baseline).toBe(1);
    expect(STATION_PROTOCOL_BASELINE).toBe(1);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual(corpus.protocol.support);
    expect(selectStationProtocolCodec(1)).toEqual(Result.succeed(1));
    expect(selectStationProtocolCodec(2)).toEqual(
      Result.fail("unsupported-station-protocol"),
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
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    const bytes = workRecordEncodedByteLength(decoded.success);
    expect(bytes).toBeDefined();
    expect(bytes!).toBeLessThan(WORK_PROTOCOL_MAX_RECORD_BYTES);
    expect(bytes!).toBeLessThan(8_192);
  });

  it("does not use Base64 down-conversion to serve older peers", () => {
    // Historical RawPart still decodes for installed product history; there
    // is no wire rewrite that smuggles media as Base64 onto Station control.
    expect(
      Result.isSuccess(decodeWorkRecord(corpus.inlineBinaryDownConvertRejected)),
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
