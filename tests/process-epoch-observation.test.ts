import { afterEach, describe, expect, it } from "vitest";
import {
  captureChildProcessEpoch,
  captureProcessEpoch,
  captureProcessGroupEpoch,
  captureProcessGroupObservation,
  childProcessEpochIsCurrent,
  processGroupEpochIsCurrent,
  readFullProcessEpochSnapshot,
  readSingleProcessEpochSnapshot,
  refreshProcessGroupObservations,
  setProcessEpochReaderForTests,
  type ProcessEpochPsRequest,
  type ProcessEpochRow,
} from "../src/main/vellum-command/process-epoch";
import { resolveSystemPs } from "../src/main/vellum-command/platform-executables";

const START = "Wed Jul 22 04:36:13 2026";
const RESTARTED = "Thu Jul 23 11:02:44 2026";

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
  it("uses one locale-fixed full ps table and requires Junto's pid witness", () => {
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

describe("single-pid process epoch reads", () => {
  it("asks ps about exactly the requested pid instead of the whole table", () => {
    const requests: ProcessEpochPsRequest[] = [];
    const rows = readSingleProcessEpochSnapshot(4242, (request) => {
      requests.push(request);
      return { status: 0, stdout: `${psLine(4242, 4242, 9)}\n`, stderr: "" };
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: expect.stringMatching(/^\/.*\/ps$/u),
      args: ["-p", "4242", "-o", "pid=,pgid=,sess=,lstart="],
      env: { LC_ALL: "C", TZ: "UTC" },
    });
    // The whole-table flag is what made every epoch question cost the
    // machine's process count. It must not appear on a single-pid read.
    expect(requests[0]?.args).not.toContain("-axo");
    expect(rows).toEqual([row(4242, 4242, 9, START)]);
  });

  it("separates a clean absent read from an unavailable observation", () => {
    // `ps` ran fine and said there is no such process.
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({ status: 1, stdout: "", stderr: "" }),
    )).toEqual([]);
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({ status: 0, stdout: "", stderr: "" }),
    )).toEqual([]);

    // Every ambiguous shape stays unavailable rather than reading as absent.
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({ status: 2, stdout: "", stderr: "" }),
    )).toBeUndefined();
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({ status: 1, stdout: "", stderr: "ps: cannot read process table" }),
    )).toBeUndefined();
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({ status: 0, stdout: undefined, stderr: "" }),
    )).toBeUndefined();
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({
        status: 0,
        stdout: `${psLine(4242, 4242, 9)}\n`,
        stderr: "",
        error: new Error("spawn failed"),
      }),
    )).toBeUndefined();
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({ status: 0, stdout: "this row is malformed\n", stderr: "" }),
    )).toBeUndefined();
    // A single-pid query that answered about anything else is incoherent.
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({ status: 0, stdout: `${psLine(77, 77, 9)}\n`, stderr: "" }),
    )).toBeUndefined();
    expect(readSingleProcessEpochSnapshot(
      4242,
      () => ({
        status: 0,
        stdout: `${psLine(4242, 4242, 9)}\n${psLine(77, 77, 9)}\n`,
        stderr: "",
      }),
    )).toBeUndefined();
  });

  it("never shells out for a pid that could not name a process", () => {
    let ran = false;
    const runner = () => {
      ran = true;
      return { status: 0, stdout: "", stderr: "" };
    };
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(readSingleProcessEpochSnapshot(pid, runner)).toBeUndefined();
    }
    expect(ran).toBe(false);
  });

  it("routes exact-pid questions narrow and member enumeration wide", () => {
    const hints: (number | undefined)[] = [];
    const table = [row(900, 900, 11, "leader-a"), row(901, 900, 11, "member-a")];
    setProcessEpochReaderForTests({
      snapshot: (pidHint) => {
        hints.push(pidHint);
        return table;
      },
    });

    const child = captureChildProcessEpoch(900)!;
    childProcessEpochIsCurrent(900, child);
    const group = captureProcessGroupEpoch(900)!;
    processGroupEpochIsCurrent(900, group);
    const observation = captureProcessGroupObservation(900)!;
    refreshProcessGroupObservations([observation]);

    // Only the two group-member questions may read the whole table.
    expect(hints).toEqual([900, 900, 900, 900, undefined, undefined]);
  });

  it("still refuses a reused pid and an absent one from single-pid reads", () => {
    let stdout = `${psLine(4242, 4242, 9, START)}\n`;
    let status = 0;
    setProcessEpochReaderForTests({
      snapshot: (pidHint) =>
        readSingleProcessEpochSnapshot(
          pidHint ?? 0,
          () => ({ status, stdout, stderr: "" }),
        ),
    });

    const captured = captureProcessEpoch(4242)!;
    expect(captured.child).toEqual({ pid: 4242, startKey: START });
    expect(captured.group).toEqual({
      processGroupId: 4242,
      sessionId: 9,
      startKey: START,
    });
    expect(childProcessEpochIsCurrent(4242, captured.child)).toBe(true);
    expect(processGroupEpochIsCurrent(4242, captured.group!)).toBe(true);

    // Same pid number, new process: `lstart` is the reuse defeater.
    stdout = `${psLine(4242, 4242, 9, RESTARTED)}\n`;
    expect(childProcessEpochIsCurrent(4242, captured.child)).toBe(false);
    expect(processGroupEpochIsCurrent(4242, captured.group!)).toBe(false);

    // A clean absent read is not a current epoch either.
    stdout = "";
    status = 1;
    expect(childProcessEpochIsCurrent(4242, captured.child)).toBe(false);
    expect(processGroupEpochIsCurrent(4242, captured.group!)).toBe(false);
    expect(captureProcessEpoch(4242)).toBeUndefined();
  });

  it("captures a group only when the pid leads its own group", () => {
    setProcessEpochReaderForTests({
      snapshot: () => [row(4243, 4242, 9, START)],
    });
    const captured = captureProcessEpoch(4243);
    expect(captured?.child).toEqual({ pid: 4243, startKey: START });
    expect(captured?.group).toBeUndefined();
  });

  it("reads its own live pid through the real single-pid ps path", () => {
    if (resolveSystemPs() === undefined) return;
    const captured = captureProcessEpoch(process.pid);
    expect(captured?.child.pid).toBe(process.pid);
    expect(captured?.child.startKey).toMatch(
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u,
    );
    expect(childProcessEpochIsCurrent(process.pid, captured!.child)).toBe(true);
    expect(childProcessEpochIsCurrent(process.pid, {
      pid: process.pid,
      startKey: RESTARTED,
    })).toBe(false);
  });
});
