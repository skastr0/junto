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

// No mocks: a real group whose leader exits while a member it started keeps
// the pipes open. The quit log must say so, not only name the generation.
describe("a quit drain that keeps a group reports what it saw", () => {
  it("names the leader's exit, the open pipes, every group pid and the signals", async () => {
    const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
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
