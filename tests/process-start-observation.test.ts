import { afterEach, describe, expect, it } from "vitest";
import {
  captureChildProcessEpoch,
  readSingleProcessEpochSnapshot,
  setProcessEpochReaderForTests,
} from "../src/main/junto/process-epoch";
import {
  makeProcessIdentityMap,
  readProcessStartKey,
} from "../src/main/junto/process-identity";

const line = (pid: number): string =>
  `${pid} ${pid} 7 Wed Jul 22 04:36:13 2026`;

afterEach(() => {
  setProcessEpochReaderForTests(undefined);
});

describe("shared single-pid start observation", () => {
  it("does not memoize a caller-supplied runner", () => {
    let calls = 0;
    const runner = () => {
      calls += 1;
      return { status: 0, stdout: `${line(42)}\n`, stderr: "" };
    };
    expect(readSingleProcessEpochSnapshot(42, runner)?.[0]?.startKey).toBe(
      "Wed Jul 22 04:36:13 2026",
    );
    expect(readSingleProcessEpochSnapshot(42, runner)?.[0]?.pid).toBe(42);
    expect(calls).toBe(2);
  });

  it("lets epoch capture and identity bind share one observation, then reads again next turn", async () => {
    const pid = process.pid;
    const rows = readSingleProcessEpochSnapshot(pid);
    const epoch = captureChildProcessEpoch(pid);
    const shared = readSingleProcessEpochSnapshot(pid);
    expect(rows?.[0]?.startKey).toBeTruthy();
    expect(shared).toBe(rows);
    expect(epoch?.startKey).toBe(rows?.[0]?.startKey);
    expect(readProcessStartKey(pid)).toBe(epoch?.startKey);

    const map = makeProcessIdentityMap();
    expect(map.bind(pid, { agentKey: "local:shared" })).toBe(true);
    expect(map.resolve(pid)?.agentKey).toBe("local:shared");
    expect(readSingleProcessEpochSnapshot(pid)).toBe(rows);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const fresh = readSingleProcessEpochSnapshot(pid);
    expect(fresh).not.toBe(rows);
    expect(fresh?.[0]?.startKey).toBe(rows?.[0]?.startKey);
    expect(map.resolve(pid)?.agentKey).toBe("local:shared");
    map.clear();
  });
});
