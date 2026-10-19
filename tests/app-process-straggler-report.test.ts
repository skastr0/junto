import { afterEach, describe, expect, it } from "vitest";
import {
  createAppProcessPlane,
  describeAppProcessStraggler,
  type AppProcessStraggler,
} from "../src/main/junto/app-process-plane";

const leftovers: number[] = [];

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

// No mocks: real processes, the case remote-send's Preview showed.
describe("a quit drain and the members a group leader leaves", () => {
  it("signals the members it recorded when the leader exited, and drains clean", async () => {
    const plane = createAppProcessPlane({ termGraceMs: 500, killGraceMs: 500 });
    const lease = plane.spawnGroup({
      source: "test.source",
      purpose: "leader leaves a member",
      command: "/bin/sh",
      args: ["-c", "sleep 30 & echo $!; exit 0"],
    });
    lease.io.stdin.end();
    const member = await new Promise<number>((resolve) => {
      lease.io.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    leftovers.push(member);
    await lease.io.exited;

    await expect(plane.drainOnQuit()).resolves.toEqual({ clean: true, stragglers: [] });
    expect(() => process.kill(member, 0)).toThrow();
  });
});

// A member forked after the recording read is not ours to signal. The quit
// log must say what it saw, not only name the generation.
describe("a quit drain that keeps a group reports what it saw", () => {
  it("names the leader's exit, the open pipes, every group pid and the signals", async () => {
    const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
    const lease = plane.spawnGroup({
      source: "test.source",
      purpose: "leader leaves a member",
      command: "/bin/sh",
      // The subshell is recorded when the leader exits; the sleep it forks
      // half a second later is not, and holds the pipes past the drain.
      args: ["-c", "(sleep 0.5; sleep 30 &) & exit 0"],
    });
    lease.io.stdin.end();
    await lease.io.exited;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const late = (await import("node:child_process"))
      .execFileSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, pgid]) => pgid === lease.io.pidForDiagnostics && pid !== lease.io.pidForDiagnostics)
      .map(([pid]) => pid!);
    leftovers.push(...late);

    const result = await plane.drainOnQuit();
    expect(result.clean).toBe(false);
    const straggler = result.stragglers[0]!;

    expect(straggler).toMatchObject({
      source: "test.source",
      mode: "group",
      exit: { code: 0, signal: null },
    });
    const line = describeAppProcessStraggler(straggler);
    expect(line).toContain("test.source:leader leaves a member@");
    expect(line).toContain(`pid=${straggler.pid}`);
    expect(line).toContain("mode=group");
    expect(line).toContain(`state=${straggler.state}`);
    expect(line).toContain("exited code=0 signal=null");
    expect(line).toContain(straggler.closed ? "pipes closed" : "pipes open");
    expect(line).toMatch(/TERM (not sent|sent|refused)/);
    expect(line).toMatch(/KILL (not sent|sent|refused)/);
    // The recorded subshell was gone by the drain; the late sleep was never signalled.
    expect(line).toMatch(/residual \[pid=\d+ SIGTERM gone/);
    expect(late.every((pid) => { try { return process.kill(pid, 0); } catch { return false; } })).toBe(true);
  });
});

describe("describeAppProcessStraggler", () => {
  const base: AppProcessStraggler = {
    generation: 3,
    source: "ssh.process-spawner",
    purpose: "SSH transport command",
    mode: "group",
    state: "leaderless-group",
    pid: 57_797,
    closed: true,
  };

  it("keeps the old prefix so existing log searches still match", () => {
    expect(describeAppProcessStraggler(base)).toMatch(
      /^ssh\.process-spawner:SSH transport command@3 pid=57797, /,
    );
  });

  it("says when no exit was seen and no signal was sent", () => {
    const line = describeAppProcessStraggler({ ...base, state: "running", closed: false });
    expect(line).toBe(
      "ssh.process-spawner:SSH transport command@3 pid=57797, mode=group, state=running, " +
        "no exit seen, pipes open, TERM not sent, KILL not sent",
    );
  });

  it("lists group pids and each signal's route, decision and reason", () => {
    const line = describeAppProcessStraggler({
      ...base,
      exit: { code: 255, signal: null },
      groupPids: [57_797, 57_801],
      term: { signal: "SIGTERM", reason: "app-quit-drain", attempted: true, via: "process.kill-group", decision: { ok: true, mode: "group" } },
      kill: { signal: "SIGKILL", reason: "app-quit-drain", attempted: false, via: "none", decision: { ok: false, reason: "leader-exited" } },
    });
    expect(line).toContain("exited code=255 signal=null, pipes closed, group pids=[57797 57801]");
    expect(line).toContain("TERM sent via process.kill-group (group, app-quit-drain)");
    expect(line).toContain("KILL refused via none (leader-exited, app-quit-drain)");
  });
});
