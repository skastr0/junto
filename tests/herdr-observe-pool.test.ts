import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import {
  HerdrObservePool,
  type ObserveSpawnFn,
} from "../src/main/vellum/herdr/observe-pool";
import {
  HerdrStreamManager,
  type HerdrClientIo,
  type HerdrSpawnedClient,
  type HerdrStreamFrame,
  type RemoteScopeCloseReceipt,
} from "../src/main/vellum/herdr/stream";
import { setHostsSnapshot } from "../src/main/vellum/hosts/snapshot";

beforeEach(() => {
  setHostsSnapshot([
    ...defaultRemoteHostsDocument().hosts,
    {
      id: "remote-a",
      label: "Test remote",
      kind: "remote",
      endpoint: "remote-a",
      capabilities: ["herdr"],
    },
  ]);
});

afterEach(() => {
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
});

class FakeChild extends EventEmitter implements HerdrClientIo {
  readonly stdout = Object.assign(new EventEmitter(), {
    setEncoding: (): void => {},
  });
  readonly stdin = { write: (_data: string): boolean => true };
  readonly stderr = Object.assign(new EventEmitter(), {
    setEncoding: (): void => {},
  });
  readonly kills: string[] = [];
  closeCalls = 0;
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM");
    return true;
  }
  readonly closeRemote = async (): Promise<RemoteScopeCloseReceipt> => {
    this.closeCalls += 1;
    return { status: "closed" };
  };
  frame(bytes: string, full?: boolean): void {
    this.stdout.emit("data", `${JSON.stringify({ type: "terminal.frame", bytes, full })}\n`);
  }
  line(payload: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify(payload)}\n`);
  }
}

class FakeRemoteIo extends EventEmitter implements HerdrClientIo {
  readonly stdout = Object.assign(new EventEmitter(), {
    setEncoding: (): void => {},
  });
  readonly stdin = { write: (_data: string): boolean => true };
  readonly stderr = Object.assign(new EventEmitter(), {
    setEncoding: (): void => {},
  });
}

const localClient = (child: FakeChild): HerdrSpawnedClient => ({
  kind: "local-process",
  child,
  terminate: () => child.kill("SIGTERM"),
  forceTerminate: () => child.kill("SIGKILL"),
});
const remoteClient = (
  child: HerdrClientIo,
  close: () => Promise<RemoteScopeCloseReceipt>,
): HerdrSpawnedClient => ({ kind: "remote-scope", child, close });

interface SpawnCall {
  readonly hostId: string;
  readonly args: ReadonlyArray<string>;
  readonly session?: string | null;
  readonly child: FakeChild;
}

const makeSpawner = (): { calls: SpawnCall[]; spawnFn: ObserveSpawnFn } => {
  const calls: SpawnCall[] = [];
  const spawnFn: ObserveSpawnFn = (hostId, args, session) => {
    const child = new FakeChild();
    calls.push({ hostId, args, session, child });
    return hostId === "local"
      ? localClient(child)
      : remoteClient(child, child.closeRemote);
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
  const argv = [...call.args];
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
    expect(pool.retainedFrames("t1").frames).toEqual(["d1", "d2"]);
    child.frame("F1", true);
    child.frame("d3");
    expect(pool.retainedFrames("t1").frames).toEqual(["F1", "d3"]);
    expect(pool.retainedFrames("nope").frames).toEqual([]);
  });

  it("non-frame and non-JSON lines are ignored", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    const child = calls[0]!.child;
    child.line({ type: "terminal.title" });
    child.stdout.emit("data", "not json\n");
    expect(pool.retainedFrames("t1").frames).toEqual([]);
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
    expect(pool.retainedFrames("t1").frames).toEqual([]);
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
    expect(pool.retainedFrames("t1").frames).toEqual(["F1", "123456", "789012"]);
    // …until the fresh attach's full frame replaces it.
    calls[1]!.child.frame("F2", true);
    expect(pool.retainedFrames("t1").frames).toEqual(["F2"]);
  });

  it("respawn touch with new cols does not relabel retained payload until the new child's full frame arrives", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    pool.ensureObserve({ hostId: "local", terminalId: "t1", cols: 120, rows: 32 });
    calls[0]!.child.frame("F1", true);
    calls[0]!.child.emit("close", 1); // child dies: entry goes stale, retention kept
    expect(pool.entryState("t1")).toEqual({ live: false, stale: true });
    expect(pool.retainedFrames("t1")).toEqual({ frames: ["F1"], cols: 120, rows: 32 });

    // Renderer re-measures at 140x45 and touches the (now stale) entry — respawns.
    pool.ensureObserve({ hostId: "local", terminalId: "t1", cols: 140, rows: 45 });
    expect(calls.length).toBe(2);
    expect(calls[1]!.args.join(" ")).toContain("--cols 140 --rows 45");
    // No replacement frame has arrived yet — retained payload must still
    // describe the OLD (120x32) pixels actually held, not the new request.
    expect(pool.retainedFrames("t1")).toEqual({ frames: ["F1"], cols: 120, rows: 32 });

    // The new child's full frame arrives — only now does the label flip.
    calls[1]!.child.frame("F2", true);
    expect(pool.retainedFrames("t1")).toEqual({ frames: ["F2"], cols: 140, rows: 45 });
  });

  it("a delta arriving before any full frame reports the spawned child's geometry, not a pending resize", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    pool.ensureObserve({ hostId: "local", terminalId: "t1", cols: 100, rows: 28 });
    calls[0]!.child.frame("d1"); // delta with no prior full frame
    expect(pool.retainedFrames("t1")).toEqual({ frames: ["d1"], cols: 100, rows: 28 });
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
    expect(pool.retainedFrames("t1").frames).toEqual(["F1"]);

    expect(touch(pool, "t1")).toEqual({ pooled: true });
    expect(calls.length).toBe(2);
    expect(pool.entryState("t1")?.live).toBe(true);
    expect(pool.retainedFrames("t1").frames).toEqual(["F1"]); // retention kept across respawn
  });

  it("retires an exited observation generation and only signals its live replacement", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    const first = calls[0]!.child;

    first.emit("close", 0);
    expect(first.kills).toEqual([]); // natural exit is release-only
    expect(touch(pool, "t1")).toEqual({ pooled: true });
    const replacement = calls[1]!.child;

    // Late events from the retired generation cannot mutate or terminate the
    // replacement's observation lease.
    first.emit("error", new Error("late old-generation error"));
    expect(pool.entryState("t1")).toEqual({ live: true, stale: false });
    pool.stopAll();

    expect(first.kills).toEqual([]);
    expect(replacement.kills).toEqual(["SIGTERM"]);
  });

  it("releaseByHost closes and drops every remote entry for that host only", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "l1", "local");
    touch(pool, "m1", "remote-a");
    touch(pool, "m2", "remote-a");

    pool.releaseByHost("remote-a");

    expect(pool.entryState("m1")).toBeUndefined();
    expect(pool.entryState("m2")).toBeUndefined();
    expect(pool.retainedFrames("m1").frames).toEqual([]);
    expect(pool.entryState("l1")?.live).toBe(true);
    const closedTerminals = calls
      .filter((call) => call.child.closeCalls > 0)
      .map(observedTerminal)
      .sort();
    expect(closedTerminals).toEqual(["m1", "m2"]);
  });

  it("releaseObserve kills and drops; stopAll kills everything and refuses new observes", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    touch(pool, "t2");
    pool.releaseObserve("t1");
    expect(calls[0]!.child.kills).toEqual(["SIGTERM"]);
    expect(pool.entryState("t1")).toBeUndefined();
    expect(pool.retainedFrames("t1").frames).toEqual([]);

    pool.stopAll();
    expect(calls[1]!.child.kills).toEqual(["SIGTERM"]);
    expect(touch(pool, "t3")).toEqual({ pooled: false });
    expect(calls.length).toBe(2);
  });
});

describe("HerdrObservePool idle leases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the sweep timer lazily with the first entry and stops it when the pool empties", () => {
    const { spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    expect(vi.getTimerCount()).toBe(0);

    touch(pool, "t1");
    expect(vi.getTimerCount()).toBe(1);

    pool.releaseObserve("t1");
    expect(vi.getTimerCount()).toBe(1); // TERM grace timer replaces idle sweep
    vi.advanceTimersByTime(1_500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a quiet child past the lease, keeps retention, and respawns on next touch", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn, idleLeaseMs: 5 * 60_000, idleSweepMs: 60_000 });
    touch(pool, "t1");
    calls[0]!.child.frame("F1", true);
    expect(pool.entryState("t1")?.live).toBe(true);

    vi.advanceTimersByTime(5 * 60_000 + 60_000); // past the lease, one sweep tick beyond
    expect(calls[0]!.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pool.entryState("t1")).toEqual({ live: false, stale: true });
    // Retention and its geometry survive the idle release — last pixels are still true.
    expect(pool.retainedFrames("t1")).toEqual({ frames: ["F1"], cols: 80, rows: 24 });

    expect(touch(pool, "t1")).toEqual({ pooled: true }); // respawns on demand
    expect(calls.length).toBe(2);
    expect(pool.entryState("t1")?.live).toBe(true);
  });

  it("respawned child survives a sweep tick before it has sent its own first frame", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn, idleLeaseMs: 5 * 60_000, idleSweepMs: 60_000 });
    touch(pool, "t1");
    calls[0]!.child.frame("F1", true);

    vi.advanceTimersByTime(5 * 60_000 + 60_000); // past the lease, released
    expect(pool.entryState("t1")).toEqual({ live: false, stale: true });

    touch(pool, "t1"); // respawns; new child has sent no frame yet
    expect(calls.length).toBe(2);
    expect(pool.entryState("t1")?.live).toBe(true);

    vi.advanceTimersByTime(60_000); // one more sweep tick, still no frame from the new child
    expect(calls[1]!.child.kills).toEqual([]);
    expect(pool.entryState("t1")).toEqual({ live: true, stale: false });
  });

  it("active entries survive idle sweeps as long as frames keep arriving", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn, idleLeaseMs: 5 * 60_000, idleSweepMs: 60_000 });
    touch(pool, "t1");
    calls[0]!.child.frame("F1", true);

    vi.advanceTimersByTime(4 * 60_000); // under the lease
    calls[0]!.child.frame("d1"); // fresh activity resets the quiet clock
    vi.advanceTimersByTime(4 * 60_000); // 8min since F1, but only 4min since d1

    expect(pool.entryState("t1")?.live).toBe(true);
    expect(calls[0]!.child.kills).toEqual([]);
  });

  it("stopAll clears the sweep timer", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    expect(vi.getTimerCount()).toBe(1);

    pool.stopAll();
    expect(vi.getTimerCount()).toBe(1); // bounded child termination remains
    vi.advanceTimersByTime(1_500);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls[0]!.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("escalates only a retired TERM-resistant generation after an observe respawn", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    const first = calls[0]!.child;

    pool.pauseForControl("t1");
    expect(first.kills).toEqual(["SIGTERM"]);
    expect(touch(pool, "t1")).toEqual({ pooled: true });
    const replacement = calls[1]!.child;
    expect(replacement.kills).toEqual([]);

    // Generic error during TERM is not terminal proof: old authority remains
    // live for escalation and cannot follow the entry to its replacement.
    first.emit("error", new Error("TERM delivery uncertain"));

    vi.advanceTimersByTime(1_500);
    expect(first.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(replacement.kills).toEqual([]);
    expect(pool.entryState("t1")).toEqual({ live: true, stale: false });

    pool.stopAll();
    replacement.emit("close", 0);
    vi.advanceTimersByTime(1_500);
    expect(replacement.kills).toEqual(["SIGTERM"]);
  });

  it("turns an observe error-before-close into exact bounded teardown", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    touch(pool, "t1");
    const first = calls[0]!.child;

    first.emit("error", new Error("observe transport failed"));
    expect(first.kills).toEqual(["SIGTERM"]);
    expect(pool.entryState("t1")).toEqual({ live: false, stale: true });
    expect(touch(pool, "t1")).toEqual({ pooled: true });
    const replacement = calls[1]!.child;

    vi.advanceTimersByTime(1_500);
    expect(first.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(replacement.kills).toEqual([]);
    expect(pool.entryState("t1")).toEqual({ live: true, stale: false });

    first.emit("close", 1);
    expect(pool.entryState("t1")).toEqual({ live: true, stale: false });
    pool.stopAll();
    replacement.emit("close", 0);
  });
});

describe("HerdrObservePool process intent", () => {
  it("passes typed host, session, and herdr args to the scoped factory", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    pool.ensureObserve({ hostId: "remote-a", session: "ops", terminalId: "tr", cols: 100, rows: 30 });
    const remote = calls[0]!;
    expect(remote.hostId).toBe("remote-a");
    expect(remote.session).toBe("ops");
    expect(remote.args.join(" ")).toBe("terminal session observe tr --cols 100 --rows 30");

    pool.ensureObserve({ hostId: "local", terminalId: "tl", cols: 80, rows: 24 });
    const local = calls[1]!;
    expect(local.hostId).toBe("local");
    expect(local.args).toEqual(["terminal", "session", "observe", "tl", "--cols", "80", "--rows", "24"]);

    expect(pool.ensureObserve({ hostId: "evil-host", terminalId: "tx", cols: 80, rows: 24 })).toEqual({
      pooled: false,
    });
  });
});

describe("HerdrObservePool remote scope lifecycle", () => {
  it("has no kill capability, coalesces error/stop, and awaits the close receipt", async () => {
    const child = new FakeRemoteIo();
    let resolveClose!: (receipt: RemoteScopeCloseReceipt) => void;
    const closeReceipt = new Promise<RemoteScopeCloseReceipt>((resolve) => {
      resolveClose = resolve;
    });
    let closeCalls = 0;
    const pool = new HerdrObservePool({
      spawnFn: () => remoteClient(child, () => {
        closeCalls += 1;
        return closeReceipt;
      }),
    });

    expect(touch(pool, "remote", "remote-a")).toEqual({ pooled: true });
    expect("kill" in child).toBe(false);
    child.emit("error", new Error("remote lease failed"));

    let stopped = false;
    const stopping = pool.stopAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(closeCalls).toBe(1);
    expect(stopped).toBe(false);

    resolveClose({ status: "closed" });
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("control stream ↔ observe pool handoff", () => {
  const makeStreams = (pool: HerdrObservePool) => {
    const controlChildren: FakeChild[] = [];
    const controlSpawn = (() => {
      const child = new FakeChild();
      controlChildren.push(child);
      return localClient(child);
    });
    const streams = new HerdrStreamManager(pool, controlSpawn, async (name) => `/tmp/${name}`);
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
    expect(opened.ok && opened.retained).toEqual({ frames: ["F1", "d1"], cols: 80, rows: 24 });
    expect(calls[0]!.child.kills).toEqual(["SIGTERM"]); // observe paused
    expect(pool.entryState("t1")?.live).toBe(false);
    // Retention held until the first live control frame…
    expect(pool.retainedFrames("t1").frames).toEqual(["F1", "d1"]);
    controlChildren[0]!.frame("C1", true);
    expect(pool.retainedFrames("t1").frames).toEqual([]);
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
    expect(calls[0]!.hostId).toBe("local");
    expect(calls[0]!.args).toContain("observe");
    expect(observedTerminal(calls[0]!)).toBe("t1");
    expect(calls[0]!.args.join(" ")).toContain("--cols 120 --rows 40");
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
    expect(events[1]!.reason).toBe("child_error");
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
    expect(pool.retainedFrames("t1").frames).toEqual([]);
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

  it("preserves measured geometry on entry update and exposes cols/rows on retainedFrames", () => {
    const { calls, spawnFn } = makeSpawner();
    const pool = new HerdrObservePool({ spawnFn });
    pool.ensureObserve({ hostId: "local", terminalId: "t1", cols: 120, rows: 32 });
    calls[0]!.child.frame("F1", true);

    const retainedInitial = pool.retainedFrames("t1");
    expect(retainedInitial.frames).toEqual(["F1"]);
    expect(retainedInitial.cols).toBe(120);
    expect(retainedInitial.rows).toBe(32);

    // Renderer measures terminal at 140x45 and touches pool while process is live
    pool.ensureObserve({ hostId: "local", terminalId: "t1", cols: 140, rows: 45 });
    const retainedUpdated = pool.retainedFrames("t1");
    // Spawned child process geometry remains 120x32 so retained frame metadata matches actual rendered pixels
    expect(retainedUpdated.cols).toBe(120);
    expect(retainedUpdated.rows).toBe(32);
  });
});
