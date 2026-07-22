import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HerdrStreamManager, type HerdrProcessLike, type ObservePoolHooks } from "../src/main/vellum/herdr/stream";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import { setHostsSnapshot } from "../src/main/vellum/hosts/snapshot";

class FakeProcess extends EventEmitter implements HerdrProcessLike {
  written: string[] = [];
  killCalls = 0;
  killedSignal: NodeJS.Signals | undefined;
  stdin = {
    write: (chunk: string) => {
      this.written.push(chunk);
      return true;
    },
  };
  stdout = {
    setEncoding: () => undefined,
    on: () => undefined,
  };
  stderr = {
    setEncoding: () => undefined,
    on: () => undefined,
  };
  kill(sig?: NodeJS.Signals) {
    this.killCalls += 1;
    this.killedSignal = sig ?? "SIGTERM";
  }
}

const mockPool: ObservePoolHooks = {
  ensureObserve: () => ({ pooled: true }),
  retainedFrames: () => ({ frames: ["F1"], cols: 120, rows: 32 }),
  pauseForControl: () => undefined,
  clearRetention: () => undefined,
  releaseObserve: () => undefined,
  stopAll: () => undefined,
};

describe("HerdrStreamManager geometry bounds normalization", () => {
  it("normalizes resize numeric inputs (0, NaN, Infinity, negative, fractions)", () => {
    let proc: FakeProcess | undefined;
    const mgr = new HerdrStreamManager(
      mockPool,
      () => {
        proc = new FakeProcess();
        return proc;
      },
      async () => "/tmp/img",
    );

    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // 0: cols clamps to 20, rows clamps to 5
    mgr.resize(opened.streamId, 0, 0);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 20, rows: 5 }) + "\n");

    // NaN: falls back to 80x24
    mgr.resize(opened.streamId, NaN, NaN);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 80, rows: 24 }) + "\n");

    // Infinity: falls back to 80x24
    mgr.resize(opened.streamId, Infinity, -Infinity);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 80, rows: 24 }) + "\n");

    // Negative: clamps to min bounds 20x5
    mgr.resize(opened.streamId, -10, -50);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 20, rows: 5 }) + "\n");

    // Fractional: floors to integer
    mgr.resize(opened.streamId, 110.8, 40.2);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 110, rows: 40 }) + "\n");
  });

  it("normalizes scroll numeric inputs (NaN, zero, negative, pointer cell bounds)", () => {
    let proc: FakeProcess | undefined;
    const mgr = new HerdrStreamManager(
      mockPool,
      () => {
        proc = new FakeProcess();
        return proc;
      },
      async () => "/tmp/img",
    );

    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Scroll with NaN delta and NaN pointer coordinates
    mgr.scroll(opened.streamId, NaN, { column: NaN, row: NaN, modifiers: NaN });
    const lastPayload = JSON.parse(proc?.written.at(-1) ?? "{}");
    expect(lastPayload).toEqual({
      type: "terminal.scroll",
      direction: "down",
      lines: 1,
      column: 0,
      row: 0,
      modifiers: 0,
    });
  });
});

describe("HerdrStreamManager multi-stream concurrency", () => {
  const makeMgr = () => {
    const children: FakeProcess[] = [];
    const closed: Array<{ streamId: string; reason?: string }> = [];
    const mgr = new HerdrStreamManager(
      mockPool,
      () => {
        const proc = new FakeProcess();
        children.push(proc);
        return proc;
      },
      async () => "/tmp/img",
    );
    mgr.setSink((frame) => {
      if (frame.type === "closed") closed.push({ streamId: frame.streamId, reason: frame.reason });
    });
    return { mgr, children, closed };
  };

  it("two opens with different terminalIds both stay active", () => {
    const { mgr, children, closed } = makeMgr();

    const a = mgr.open({ hostId: "local", terminalId: "t-a", cols: 80, rows: 24 });
    const b = mgr.open({ hostId: "local", terminalId: "t-b", cols: 80, rows: 24 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Neither supersedes the other — both control clients still live.
    expect(children).toHaveLength(2);
    expect(children[0]!.killedSignal).toBeUndefined();
    expect(children[1]!.killedSignal).toBeUndefined();
    expect(closed).toEqual([]);

    // Input routes to the correct stream only.
    mgr.inputText(a.streamId, "alpha");
    mgr.inputText(b.streamId, "beta");
    expect(children[0]!.written.some((w) => w.includes("alpha"))).toBe(true);
    expect(children[0]!.written.some((w) => w.includes("beta"))).toBe(false);
    expect(children[1]!.written.some((w) => w.includes("beta"))).toBe(true);
    expect(children[1]!.written.some((w) => w.includes("alpha"))).toBe(false);

    // Closing one leaves the other active.
    mgr.close(a.streamId);
    expect(children[0]!.killedSignal).toBe("SIGTERM");
    expect(children[1]!.killedSignal).toBeUndefined();
    expect(mgr.inputText(a.streamId, "x").ok).toBe(false);
    expect(mgr.inputText(b.streamId, "still-here").ok).toBe(true);
  });

  it("second open same terminalId replaces only that one", () => {
    const { mgr, children, closed } = makeMgr();

    const keep = mgr.open({ hostId: "local", terminalId: "keep", cols: 80, rows: 24 });
    const first = mgr.open({ hostId: "local", terminalId: "same", cols: 80, rows: 24 });
    expect(keep.ok && first.ok).toBe(true);
    if (!keep.ok || !first.ok) return;

    const second = mgr.open({ hostId: "local", terminalId: "same", cols: 100, rows: 30 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Prior control for "same" superseded; "keep" untouched.
    expect(children).toHaveLength(3);
    expect(children[0]!.killedSignal).toBeUndefined(); // keep
    expect(children[1]!.killedSignal).toBe("SIGTERM"); // first same
    expect(children[2]!.killedSignal).toBeUndefined(); // second same
    expect(closed).toEqual([{ streamId: first.streamId, reason: "superseded" }]);
    expect(second.streamId).not.toBe(first.streamId);

    // Old streamId rejected; new same + keep both accept input.
    expect(mgr.inputText(first.streamId, "stale").ok).toBe(false);
    expect(mgr.inputText(second.streamId, "fresh").ok).toBe(true);
    expect(mgr.inputText(keep.streamId, "other").ok).toBe(true);
    expect(children[0]!.written.some((w) => w.includes("other"))).toBe(true);
    expect(children[2]!.written.some((w) => w.includes("fresh"))).toBe(true);
  });

  it("detachAllOnQuit detaches every concurrent control stream", () => {
    const { mgr, children, closed } = makeMgr();
    const a = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    const b = mgr.open({ hostId: "local", terminalId: "t2", cols: 80, rows: 24 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    mgr.detachAllOnQuit("app_quit");
    expect(children[0]!.killedSignal).toBe("SIGTERM");
    expect(children[1]!.killedSignal).toBe("SIGTERM");
    expect(closed.map((c) => c.reason)).toEqual(["app_quit", "app_quit"]);
    expect(mgr.inputText(a.streamId, "x").ok).toBe(false);
    expect(mgr.inputText(b.streamId, "x").ok).toBe(false);
    // Further opens rejected after shutdown.
    expect(mgr.open({ hostId: "local", terminalId: "t3", cols: 80, rows: 24 }).ok).toBe(false);
  });

  it("signals a detached session child exactly once across idempotent and late teardown", () => {
    const { mgr, children, closed } = makeMgr();
    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(mgr.close(opened.streamId)).toEqual({ ok: true });
    expect(mgr.close(opened.streamId)).toEqual({ ok: true });
    // A late close from the already-detached OS child only retires its sealed
    // handle; it cannot signal or re-open lifecycle work.
    children[0]!.emit("close", 0);

    expect(children[0]!.killCalls).toBe(1);
    expect(children[0]!.killedSignal).toBe("SIGTERM");
    expect(closed).toEqual([{ streamId: opened.streamId, reason: "client_close" }]);
  });
});

describe("HerdrStreamManager host revocation", () => {
  it("detachByHost detaches every stream for that host only, without re-pooling", () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      { id: "studio", label: "Studio", kind: "remote", endpoint: "studio", capabilities: ["herdr"] },
    ]);
    try {
      const spawnedBy: Record<string, FakeProcess[]> = {};
      const pooled: string[] = [];
      const pool: ObservePoolHooks = {
        ...mockPool,
        ensureObserve: (input) => {
          pooled.push(input.terminalId);
          return { pooled: true };
        },
      };
      const mgr = new HerdrStreamManager(
        pool,
        (hostId) => {
          const proc = new FakeProcess();
          (spawnedBy[hostId] ??= []).push(proc);
          return proc;
        },
        async () => "/tmp/img",
      );
      const closed: Array<{ streamId: string; reason?: string }> = [];
      mgr.setSink((frame) => {
        if (frame.type === "closed") closed.push({ streamId: frame.streamId, reason: frame.reason });
      });

      const local = mgr.open({ hostId: "local", terminalId: "t-local", cols: 80, rows: 24 });
      const s1 = mgr.open({ hostId: "studio", terminalId: "t-s1", cols: 80, rows: 24 });
      const s2 = mgr.open({ hostId: "studio", terminalId: "t-s2", cols: 80, rows: 24 });
      expect(local.ok && s1.ok && s2.ok).toBe(true);
      if (!local.ok || !s1.ok || !s2.ok) return;

      mgr.detachByHost("studio", "host_revoked");

      expect(spawnedBy.studio?.every((proc) => proc.killedSignal === "SIGTERM")).toBe(true);
      expect(spawnedBy.local?.[0]!.killedSignal).toBeUndefined();
      expect(closed).toEqual([
        { streamId: s1.streamId, reason: "host_revoked" },
        { streamId: s2.streamId, reason: "host_revoked" },
      ]);
      // The revoked host's terminals never bounce back into the observe pool.
      expect(pooled).toEqual([]);
      // The untouched host's stream is unaffected.
      expect(mgr.inputText(local.streamId, "still-here").ok).toBe(true);
      expect(mgr.inputText(s1.streamId, "gone").ok).toBe(false);
    } finally {
      setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    }
  });
});
