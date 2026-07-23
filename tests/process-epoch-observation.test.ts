import { afterEach, describe, expect, it } from "vitest";
import {
  captureProcessGroupObservation,
  readFullProcessEpochSnapshot,
  refreshProcessGroupObservations,
  setProcessEpochReaderForTests,
  type ProcessEpochPsRequest,
  type ProcessEpochRow,
} from "../src/main/vellum/process-epoch";

const START = "Wed Jul 22 04:36:13 2026";

const row = (
  pid: number,
  processGroupId: number,
  sessionId: number,
  startKey = `${START}:${pid}`,
): ProcessEpochRow => ({ pid, processGroupId, sessionId, startKey });

const psLine = (
  pid: number,
  processGroupId: number,
  sessionId: number,
  startKey = START,
): string => `${pid} ${processGroupId} ${sessionId} ${startKey}`;

afterEach(() => {
  setProcessEpochReaderForTests(undefined);
});

describe("full process epoch snapshots", () => {
  it("uses one locale-fixed full ps table and requires Vellum's pid witness", () => {
    let request: ProcessEpochPsRequest | undefined;
    const snapshot = readFullProcessEpochSnapshot(
      (next) => {
        request = next;
        return {
          status: 0,
          stdout: `${psLine(51, 51, 9)}\n${psLine(77, 51, 9)}\n`,
          stderr: "",
        };
      },
      51,
    );

    expect(request).toMatchObject({
      command: expect.stringMatching(/^\/.*\/ps$/u),
      args: ["-axo", "pid=,pgid=,sess=,lstart="],
      env: { LC_ALL: "C", TZ: "UTC" },
    });
    expect(snapshot).toEqual([
      row(51, 51, 9, START),
      row(77, 51, 9, START),
    ]);

    expect(readFullProcessEpochSnapshot(
      () => ({ status: 0, stdout: `${psLine(77, 51, 9)}\n`, stderr: "" }),
      51,
    )).toBeUndefined();
  });

  it("accepts Linux kernel rows with pgid zero without minting group authority", () => {
    const snapshot = readFullProcessEpochSnapshot(
      () => ({
        status: 0,
        stdout: `${psLine(2, 0, 0)}\n${psLine(51, 51, 9)}\n`,
        stderr: "",
      }),
      51,
    );

    expect(snapshot).toEqual([
      row(2, 0, 0, START),
      row(51, 51, 9, START),
    ]);
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    expect(captureProcessGroupObservation(2)).toBeUndefined();
    expect(captureProcessGroupObservation(51)).toMatchObject({
      originalProcessGroupId: 51,
    });
  });

  it("rejects the entire snapshot for any malformed nonblank row", () => {
    expect(readFullProcessEpochSnapshot(
      () => ({
        status: 0,
        stdout: `${psLine(51, 51, 9)}\nthis row is malformed\n${psLine(77, 51, 9)}\n`,
        stderr: "",
      }),
      51,
    )).toBeUndefined();
  });

  it("treats failed, truncated-looking, and duplicate-pid tables as unavailable", () => {
    expect(readFullProcessEpochSnapshot(
      () => ({ status: 1, stdout: psLine(51, 51, 9), stderr: "ps failed" }),
      51,
    )).toBeUndefined();
    expect(readFullProcessEpochSnapshot(
      () => ({ status: 0, stdout: psLine(51, 51, 9), stderr: "partial read" }),
      51,
    )).toBeUndefined();
    expect(readFullProcessEpochSnapshot(
      () => ({
        status: 0,
        stdout: `${psLine(51, 51, 9)}\n${psLine(51, 88, 10)}\n`,
        stderr: "",
      }),
      51,
    )).toBeUndefined();
  });
});

describe("original process-group observations", () => {
  it("unions newly observed group members and follows their exact epochs after they move", () => {
    let snapshot: readonly ProcessEpochRow[] | undefined = [
      row(500, 500, 12, "leader-a"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const captured = captureProcessGroupObservation(500);
    expect(captured).toEqual({
      originalProcessGroupId: 500,
      sessionId: 12,
      observedMemberEpochs: [{ pid: 500, startKey: "leader-a" }],
    });

    snapshot = [row(501, 500, 12, "member-a")];
    const withMember = refreshProcessGroupObservations([captured!]);
    expect(withMember).toEqual([{
      clean: false,
      observation: {
        originalProcessGroupId: 500,
        sessionId: 12,
        observedMemberEpochs: [
          { pid: 500, startKey: "leader-a" },
          { pid: 501, startKey: "member-a" },
        ],
      },
    }]);

    snapshot = [row(501, 900, 12, "member-a")];
    expect(refreshProcessGroupObservations([withMember![0]!.observation]))
      .toEqual([{ clean: false, observation: withMember![0]!.observation }]);

    snapshot = [row(501, 900, 12, "member-reused")];
    expect(refreshProcessGroupObservations([withMember![0]!.observation]))
      .toEqual([{ clean: true, observation: withMember![0]!.observation }]);
  });

  it("lets reused original group identity delay clean observation but never prove it", () => {
    let snapshot: readonly ProcessEpochRow[] | undefined = [
      row(600, 600, 14, "leader-a"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const captured = captureProcessGroupObservation(600)!;

    snapshot = [row(777, 600, 14, "unrelated-a")];
    const delayed = refreshProcessGroupObservations([captured]);
    expect(delayed?.[0]).toMatchObject({ clean: false });
    expect(delayed?.[0]?.observation.observedMemberEpochs).toContainEqual({
      pid: 777,
      startKey: "unrelated-a",
    });

    snapshot = [];
    expect(refreshProcessGroupObservations([delayed![0]!.observation]))
      .toEqual([{ clean: true, observation: delayed![0]!.observation }]);
  });

  it("keeps every observation unclean when the one refresh snapshot is unavailable", () => {
    let snapshot: readonly ProcessEpochRow[] | undefined = [
      row(700, 700, 16, "leader-a"),
      row(701, 700, 16, "member-a"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const captured = captureProcessGroupObservation(700)!;
    snapshot = undefined;

    expect(refreshProcessGroupObservations([captured])).toBeUndefined();
  });
});
