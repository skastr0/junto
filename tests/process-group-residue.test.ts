import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginGroupResidue,
  recordGroupResidue,
  releaseOwned,
  signalGroupResidue,
  spawnDetachedProcessGroup,
  type DetachedProcessGroup,
} from "../src/main/junto/process-signal";
import { setProcessEpochReaderForTests, type ProcessEpochRow } from "../src/main/junto/process-epoch";

const spawned: DetachedProcessGroup[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  setProcessEpochReaderForTests(undefined);
  for (const group of spawned.splice(0)) {
    const closed = group.child.exitCode === null && group.child.signalCode === null
      ? once(group.child, "close")
      : Promise.resolve();
    group.child.kill("SIGKILL");
    await closed;
    releaseOwned(group.process);
  }
});

// The residue's pid authority comes from a real detached group; every table
// read after that is the fake reader, and process.kill is a spy.
const residueOf = () => {
  const group = spawnDetachedProcessGroup({ source: "test.residue", command: "/bin/sleep", args: ["30"] });
  spawned.push(group);
  expect(group.mode).toBe("group");
  const leader = group.child.pid!;
  const residue = beginGroupResidue(group.process)!;
  expect(residue).toBeDefined();
  return { leader, residue };
};

const row = (pid: number, processGroupId: number, startKey: string): ProcessEpochRow =>
  ({ pid, processGroupId, startKey });

describe("a group residue", () => {
  it("signals a recorded member only while its pgid and start time match", async () => {
    const { leader, residue } = residueOf();
    let table: readonly ProcessEpochRow[] = [row(leader + 1, leader, "member-a")];
    setProcessEpochReaderForTests({ snapshot: () => table });
    expect(await recordGroupResidue(residue)).toEqual([{ pid: leader + 1, startKey: "member-a" }]);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(signalGroupResidue(residue, "SIGTERM", "app-quit-drain-residual")).toEqual([
      { pid: leader + 1, signal: "SIGTERM", reason: "app-quit-drain-residual", outcome: "sent" },
    ]);
    expect(kill.mock.calls).toEqual([[leader + 1, "SIGTERM"]]);

    // Same pid, new process: never signalled.
    table = [row(leader + 1, leader, "member-reused")];
    expect(signalGroupResidue(residue, "SIGKILL", "app-quit-drain-residual")[0]!.outcome).toBe("changed");
    // Same process, moved to another group: never signalled.
    table = [row(leader + 1, leader + 50, "member-a")];
    expect(signalGroupResidue(residue, "SIGKILL", "app-quit-drain-residual")[0]!.outcome).toBe("changed");
    table = [];
    expect(signalGroupResidue(residue, "SIGKILL", "app-quit-drain-residual")[0]!.outcome).toBe("gone");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("never adds a row that joins the pgid after the one recording read", async () => {
    const { leader, residue } = residueOf();
    let table: readonly ProcessEpochRow[] = [];
    setProcessEpochReaderForTests({ snapshot: () => table });
    expect(await recordGroupResidue(residue)).toEqual([]);

    // The daemon double fork after the group emptied: pgid L with no row at L.
    table = [row(leader + 7, leader, "someone-else")];
    expect(await recordGroupResidue(residue)).toEqual([]);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(signalGroupResidue(residue, "SIGTERM", "app-quit-drain-residual")).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("records nothing when the recording read still finds a row at the leader's pid", async () => {
    const { leader, residue } = residueOf();
    setProcessEpochReaderForTests({
      snapshot: () => [row(leader, leader, "pid-back"), row(leader + 1, leader, "member-a")],
    });
    expect(await recordGroupResidue(residue)).toBeUndefined();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(signalGroupResidue(residue, "SIGTERM", "app-quit-drain-residual")).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not signal when the single-pid read fails", async () => {
    const { leader, residue } = residueOf();
    let readable = true;
    setProcessEpochReaderForTests({ snapshot: () => (readable ? [row(leader + 1, leader, "member-a")] : undefined) });
    await recordGroupResidue(residue);
    readable = false;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(signalGroupResidue(residue, "SIGTERM", "app-quit-drain-residual")[0]!.outcome).toBe("unreadable");
    expect(kill).not.toHaveBeenCalled();
  });

  it("is minted only from live group authority", () => {
    const group = spawnDetachedProcessGroup({ source: "test.residue", command: "/bin/sleep", args: ["30"] });
    spawned.push(group);
    releaseOwned(group.process);
    expect(beginGroupResidue(group.process)).toBeUndefined();
  });
});
