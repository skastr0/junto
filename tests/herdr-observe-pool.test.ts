import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HerdrObservePool,
  type ObserveChildLike,
  type ObserveSpawnFn,
} from "../src/main/vellum/herdr/observe-pool";
import { HerdrStreamManager, type HerdrStreamFrame } from "../src/main/vellum/herdr/stream";

class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), {
    setEncoding: (): void => {},
  });
  readonly stdin = { write: (_data: string): boolean => true };
  readonly stderr = Object.assign(new EventEmitter(), {
    setEncoding: (): void => {},
  });
  readonly kills: string[] = [];
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM");
    return true;
  }
  frame(bytes: string, full?: boolean): void {
    this.stdout.emit("data", `${JSON.stringify({ type: "terminal.frame", bytes, full })}\n`);
  }
  line(payload: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify(payload)}\n`);
  }
}

interface SpawnCall {
  readonly command: string;
  readonly argv: ReadonlyArray<string>;
  readonly child: FakeChild;
}

const makeSpawner = (): { calls: SpawnCall[]; spawnFn: ObserveSpawnFn } => {
  const calls: SpawnCall[] = [];
  const spawnFn: ObserveSpawnFn = (command, argv) => {
    const child = new FakeChild();
    calls.push({ command, argv, child });
    return child as unknown as ObserveChildLike;
  };
  return { calls, spawnFn };
};

const touch = (
  pool: HerdrObservePool,
  terminalId: string,
  hostId = "local",
): { readonly pooled: boolean } =>
  pool.ensureObserve({ hostId, terminalId, cols: 80, rows: 24 });

const observedTerminal = (call: SpawnCall): string => {
  const argv = [...call.argv];
  return argv[argv.indexOf("observe") + 1]!;
};

describe("HerdrObservePool LRU", () => {
  it("11th global ensureObserve evicts the least-recently-touched", () => {
    const { calls, spawnFn } = makeSpawner();
    // Per-host raised so the global cap (default 10) is the binding one.
    const pool = new HerdrObservePool({ maxPerHost: 20, spawnFn });
    for (let i = 1; i <= 10; i++) touch(pool, `t${i}`);
    expect(calls.length).toBe(10);
    touch(pool, "t1"); // LRU-touch: t2 becomes oldest
    expect(calls.length).toBe(10); // already pooled — no respawn

    touch(pool, "t11");
    expect(calls.length).toBe(11);
    expect(calls[1]!.child.kills).toEqual(["SIGTERM"]); // t2 evicted
    expect(pool.entryState("t2")).toEqual({ live: false, stale: true });
    expect(pool.entryState("t1")?.live).toBe(true);
    expect(pool.entryState("t11")?.live).toBe(true);
  });

  it("6th observe on one host evicts that host's oldest only", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    for (let i = 1; i <= 5; i++) touch(pool, `l${i}`, "local");
    touch(pool, "m1", "remote-a");
    touch(pool, "l1", "local"); // l2 is now local's oldest

    touch(pool, "l6", "local");
    const killed = calls.filter((c) => c.child.kills.length > 0).map(observedTerminal);
    expect(killed).toEqual(["l2"]);
    expect(pool.entryState("m1")?.live).toBe(true); // other host untouched
    expect(pool.entryState("l6")?.live).toBe(true);
  });
});

describe("HerdrObservePool retention", () => {
  it("deltas append in order; full frame replaces and clears deltas", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    const child = calls[0]!.child;
    child.frame("d1");
    child.frame("d2");
    expect(pool.retainedFrames("t1")).toEqual(["d1", "d2"]);
    child.frame("F1", true);
    child.frame("d3");
    expect(pool.retainedFrames("t1")).toEqual(["F1", "d3"]);
    expect(pool.retainedFrames("nope")).toEqual([]);
  });

  it("non-frame and non-JSON lines are ignored", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    const child = calls[0]!.child;
    child.line({ type: "terminal.title" });
    child.stdout.emit("data", "not json\n");
    expect(pool.retainedFrames("t1")).toEqual([]);
    expect(pool.entryState("t1")?.live).toBe(true);
  });

  it("terminal.closed from the host drops the entry and its retention", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    const child = calls[0]!.child;
    child.frame("F1", true);
    child.line({ type: "terminal.closed" });
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(pool.entryState("t1")).toBeUndefined();
    expect(pool.retainedFrames("t1")).toEqual([]);
  });

  it("dead entries beyond maxEntries are pruned oldest-first; live entries survive", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ maxGlobal: 2, maxPerHost: 20, maxEntries: 3, spawnFn });
    // t1..t4: global cap 2 keeps evicting → dead stale entries accumulate.
    for (let i = 1; i <= 4; i++) touch(pool, `t${i}`);
    // maxEntries=3: t1 (oldest dead) pruned outright; t2 kept as stale retention.
    expect(pool.entryState("t1")).toBeUndefined();
    expect(pool.entryState("t2")).toEqual({ live: false, stale: true });
    expect(pool.entryState("t3")?.live).toBe(true);
    expect(pool.entryState("t4")?.live).toBe(true);
    expect(calls.length).toBe(4);
  });

  it("delta byte overflow kills and respawns; retention survives until the fresh full frame", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ maxDeltaBytes: 10, spawnFn });
    touch(pool, "t1");
    const first = calls[0]!.child;
    first.frame("F1", true);
    first.frame("123456");
    first.frame("789012"); // 12 delta bytes > 10 → kill + respawn
    expect(first.kills).toEqual(["SIGTERM"]);
    expect(calls.length).toBe(2);
    expect(observedTerminal(calls[1]!)).toBe("t1");
    // Retention survives across the respawn…
    expect(pool.retainedFrames("t1")).toEqual(["F1", "123456", "789012"]);
    // …until the fresh attach's full frame replaces it.
    calls[1]!.child.frame("F2", true);
    expect(pool.retainedFrames("t1")).toEqual(["F2"]);
  });
});

describe("HerdrObservePool lifecycle", () => {
  it("child exit marks the entry stale, keeps retention, and respawns on next ensureObserve", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    calls[0]!.child.frame("F1", true);
    calls[0]!.child.emit("close", 1);
    expect(pool.entryState("t1")).toEqual({ live: false, stale: true });
    expect(pool.retainedFrames("t1")).toEqual(["F1"]);

    expect(touch(pool, "t1")).toEqual({ pooled: true });
    expect(calls.length).toBe(2);
    expect(pool.entryState("t1")?.live).toBe(true);
    expect(pool.retainedFrames("t1")).toEqual(["F1"]); // retention kept across respawn
  });

  it("releaseObserve kills and drops; stopAll kills everything and refuses new observes", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    touch(pool, "t2");
    pool.releaseObserve("t1");
    expect(calls[0]!.child.kills).toEqual(["SIGTERM"]);
    expect(pool.entryState("t1")).toBeUndefined();
    expect(pool.retainedFrames("t1")).toEqual([]);

    pool.stopAll();
    expect(calls[1]!.child.kills).toEqual(["SIGTERM"]);
    expect(touch(pool, "t3")).toEqual({ pooled: false });
    expect(calls.length).toBe(2);
  });
});

describe("HerdrObservePool argv", () => {
  it("remote observe rides ssh via herdrArgv; local runs bare herdr", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    pool.ensureObserve({ hostId: "remote-a", session: "ops", terminalId: "tr", cols: 100, rows: 30 });
    const remote = calls[0]!;
    expect(remote.command).toBe("ssh");
    expect(remote.argv).toContain("remote-a");
    expect(remote.argv).toContain("herdr");
    expect(remote.argv.join(" ")).toContain("--session ops terminal session observe tr --cols 100 --rows 30");

    pool.ensureObserve({ hostId: "local", terminalId: "tl", cols: 80, rows: 24 });
    const local = calls[1]!;
    expect(local.command).toBe("herdr");
    expect(local.argv).toEqual(["terminal", "session", "observe", "tl", "--cols", "80", "--rows", "24"]);

    expect(pool.ensureObserve({ hostId: "evil-host", terminalId: "tx", cols: 80, rows: 24 })).toEqual({
      pooled: false,
    });
  });
});

describe("control stream ↔ observe pool handoff", () => {
  const makeStreams = (pool: HerdrObservePool) => {
    const controlChildren: FakeChild[] = [];
    const controlSpawn = ((_cmd: string, _argv: string[]) => {
      const child = new FakeChild();
      controlChildren.push(child);
      return child;
    }) as unknown as typeof spawn;
    const streams = new HerdrStreamManager(pool, controlSpawn);
    const events: HerdrStreamFrame[] = [];
    streams.setSink((f) => events.push(f));
    return { streams, controlChildren, events };
  };
  const openInput = { hostId: "local", terminalId: "t1", cols: 80, rows: 24 } as const;

  it("open kills the observe child, returns retained frames, and first control frame clears retention", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    calls[0]!.child.frame("F1", true);
    calls[0]!.child.frame("d1");

    const { streams, controlChildren } = makeStreams(pool);
    const opened = streams.open(openInput);
    expect(opened.ok && opened.retained).toEqual(["F1", "d1"]);
    expect(calls[0]!.child.kills).toEqual(["SIGTERM"]); // observe paused
    expect(pool.entryState("t1")?.live).toBe(false);
    // Retention held until the first live control frame…
    expect(pool.retainedFrames("t1")).toEqual(["F1", "d1"]);
    controlChildren[0]!.frame("C1", true);
    expect(pool.retainedFrames("t1")).toEqual([]);
  });

  it("control close re-pools an observe stream for the terminal at last cols/rows", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    const { streams } = makeStreams(pool);
    const opened = streams.open({ ...openInput, cols: 120, rows: 40 });
    if (!opened.ok) throw new Error("open failed");
    expect(calls.length).toBe(0); // nothing pooled yet

    streams.close(opened.streamId);
    expect(calls.length).toBe(1);
    expect(calls[0]!.command).toBe("herdr");
    expect(calls[0]!.argv).toContain("observe");
    expect(observedTerminal(calls[0]!)).toBe("t1");
    expect(calls[0]!.argv.join(" ")).toContain("--cols 120 --rows 40");
    expect(pool.entryState("t1")?.live).toBe(true);
  });

  it("control child error also hands the terminal back to the pool and emits error+closed", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    const { streams, controlChildren, events } = makeStreams(pool);
    const opened = streams.open(openInput);
    if (!opened.ok) throw new Error("open failed");
    controlChildren[0]!.emit("error", new Error("spawn ENOENT"));
    expect(calls.length).toBe(1); // re-observed
    expect(observedTerminal(calls[0]!)).toBe("t1");
    expect(pool.entryState("t1")?.live).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["error", "closed"]);
    expect(events[1]!.reason).toBe("spawn_error");
    expect(streams.getActiveStreamId()).toBeUndefined();
  });

  it("host terminal.closed on the control stream drops the pool entry instead of re-observing", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    calls[0]!.child.frame("F1", true);
    const { streams, controlChildren, events } = makeStreams(pool);
    const opened = streams.open(openInput);
    if (!opened.ok) throw new Error("open failed");
    controlChildren[0]!.line({ type: "terminal.closed", reason: "pane_gone" });
    expect(calls.length).toBe(1); // no observe respawn for a dead terminal
    expect(controlChildren[0]!.kills).toEqual(["SIGTERM"]);
    expect(pool.entryState("t1")).toBeUndefined();
    expect(pool.retainedFrames("t1")).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["closed"]);
    expect(events[0]!.reason).toBe("pane_gone");
    expect(streams.getActiveStreamId()).toBeUndefined();
  });

  it("control child exit also hands the terminal back to the pool", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    const { streams, controlChildren } = makeStreams(pool);
    const opened = streams.open(openInput);
    if (!opened.ok) throw new Error("open failed");
    controlChildren[0]!.emit("close", 1);
    expect(calls.length).toBe(1);
    expect(observedTerminal(calls[0]!)).toBe("t1");
  });

  it("app quit does not re-observe and stops the pool", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t2"); // an unrelated pooled observer
    const { streams } = makeStreams(pool);
    const opened = streams.open(openInput);
    if (!opened.ok) throw new Error("open failed");

    streams.detachAllOnQuit();
    // No observe respawn for t1 — only the original t2 spawn exists, killed.
    expect(calls.length).toBe(1);
    expect(observedTerminal(calls[0]!)).toBe("t2");
    expect(calls[0]!.child.kills).toEqual(["SIGTERM"]);
    expect(touch(pool, "t3")).toEqual({ pooled: false }); // pool shut down
  });
});
