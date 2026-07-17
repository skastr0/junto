import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/main/vellum/adapters/exec";
import { controlArgs, herdrControlDir } from "../src/main/vellum/herdr/control-path";
import { warmHost, withHostSlot, type MasterRunner } from "../src/main/vellum/herdr/masters";

const okResult: CliResult = { ok: true, stdout: "" };

describe("herdr control-path", () => {
  it("herdrControlDir resolves under ~/.vellum/ssh", () => {
    expect(herdrControlDir()).toBe(join(homedir(), ".vellum", "ssh"));
  });

  it("controlArgs shape: ControlMaster=auto, ControlPath under ~/.vellum/ssh, ControlPersist=600", () => {
    expect(controlArgs()).toEqual([
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${join(homedir(), ".vellum", "ssh")}/cm-%C`,
      "-o",
      "ControlPersist=600",
    ]);
  });
});

describe("herdr masters: warmHost", () => {
  it("builds ssh argv with control args + 'true' for remote-a", async () => {
    const calls: Array<{ command: string; argv: string[]; timeoutMs?: number }> = [];
    const runner: MasterRunner = async (command, argv, timeoutMs) => {
      calls.push({ command, argv: [...argv], timeoutMs });
      return okResult;
    };

    await warmHost("remote-a", runner);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("ssh");
    expect(calls[0]?.argv).toEqual([
      "-o",
      "ConnectTimeout=6",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      ...controlArgs(),
      "remote-a",
      "true",
    ]);
  });

  it("no-ops for local (no runner call)", async () => {
    const calls: unknown[] = [];
    const runner: MasterRunner = async (...args) => {
      calls.push(args);
      return okResult;
    };

    await warmHost("local", runner);

    expect(calls).toHaveLength(0);
  });

  it("no-ops for an unknown host", async () => {
    const calls: unknown[] = [];
    const runner: MasterRunner = async (...args) => {
      calls.push(args);
      return okResult;
    };

    await warmHost("attacker.example", runner);

    expect(calls).toHaveLength(0);
  });

  it("swallows runner failures — never throws", async () => {
    const runner: MasterRunner = async () => {
      throw new Error("ssh: connection refused");
    };

    await expect(warmHost("remote-a", runner)).resolves.toBeUndefined();
  });
});

describe("herdr masters: withHostSlot", () => {
  it("allows 3 concurrent remote fns and queues the 4th until one resolves", async () => {
    const hostId = "remote-a-slot-test-1";
    let active = 0;
    let maxActive = 0;
    const releasers: Array<() => void> = [];

    const makeSlow = () => () =>
      new Promise<number>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releasers.push(() => {
          active -= 1;
          resolve(active);
        });
      });

    const p1 = withHostSlot(hostId, makeSlow());
    const p2 = withHostSlot(hostId, makeSlow());
    const p3 = withHostSlot(hostId, makeSlow());

    // Let the three fire and settle into "active" before probing the 4th.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    let fourthStarted = false;
    const p4 = withHostSlot(hostId, async () => {
      fourthStarted = true;
      return 4;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fourthStarted).toBe(false);
    expect(maxActive).toBe(3);
    expect(releasers).toHaveLength(3);

    // Release the first slot — the queued 4th should now be able to run.
    releasers[0]?.();
    await p1;
    await Promise.resolve();
    await Promise.resolve();
    expect(fourthStarted).toBe(true);
    await expect(p4).resolves.toBe(4);

    releasers[1]?.();
    releasers[2]?.();
    await Promise.all([p2, p3]);
  });

  it("local bypasses the limiter entirely", async () => {
    let active = 0;
    let maxActive = 0;
    const releasers: Array<() => void> = [];

    const makeSlow = () => () =>
      new Promise<void>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releasers.push(() => {
          active -= 1;
          resolve();
        });
      });

    const runs = [1, 2, 3, 4, 5].map(() => withHostSlot("local", makeSlow()));

    await Promise.resolve();
    await Promise.resolve();
    expect(maxActive).toBe(5);

    for (const release of releasers) release();
    await Promise.all(runs);
  });
});
