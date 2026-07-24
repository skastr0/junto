import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  HerdrStreamManager,
  isHerdrBrokenPipeError,
  type HerdrClientIo,
  type HerdrSpawnedClient,
  type HerdrStreamFrame,
  type ObservePoolHooks,
} from "../src/main/vellum/herdr/stream";
import type { AppProcessSignalReceipt } from "../src/main/vellum/app-process-plane";

/**
 * Integration hardening against stock herdr (`terminal session control`):
 * stdin NDJSON commands, stdout NDJSON frames. When the control child dies,
 * Node emits async EPIPE on the Writable — not on ChildProcess — and an
 * unowned listener becomes Electron's "JavaScript error in the main process".
 */

const signalReceipt = (signal: "SIGTERM" | "SIGKILL"): AppProcessSignalReceipt => ({
  signal,
  reason: "test",
  attempted: true,
  decision: { ok: true, mode: "child" },
  via: "child.kill",
});

const mockPool: ObservePoolHooks = {
  ensureObserve: () => ({ pooled: true }),
  retainedFrames: () => ({ frames: [] }),
  pauseForControl: () => undefined,
  clearRetention: () => undefined,
  releaseObserve: () => undefined,
  stopAll: () => undefined,
};

class PipeControlChild extends EventEmitter implements HerdrClientIo {
  readonly sink = new PassThrough();
  readonly stdout = Object.assign(new PassThrough(), {
    setEncoding: (): void => undefined,
  });
  readonly stderr = Object.assign(new PassThrough(), {
    setEncoding: (): void => undefined,
  });
  killed = 0;
  readonly stdin: HerdrClientIo["stdin"];

  constructor() {
    super();
    // Keep the writable side open for writes until we destroy it.
    this.sink.resume();
    this.stdin = {
      write: (chunk: string): boolean => this.sink.write(chunk, "utf8"),
      once: (event: "drain", listener: () => void): unknown => this.sink.once(event, listener),
      on: (event: "error", listener: (error: Error) => void): unknown =>
        this.sink.on(event, listener),
    };
  }

  kill(): boolean {
    this.killed += 1;
    // Exact close witness so quit drain does not wait the TERM grace.
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

const localClient = (child: PipeControlChild): HerdrSpawnedClient => ({
  kind: "local-process",
  child,
  terminate: () => {
    child.kill();
    return signalReceipt("SIGTERM");
  },
  forceTerminate: () => {
    child.kill();
    return signalReceipt("SIGKILL");
  },
});

const openManager = (): {
  readonly mgr: HerdrStreamManager;
  readonly child: () => PipeControlChild;
  readonly frames: HerdrStreamFrame[];
} => {
  let child: PipeControlChild | undefined;
  const frames: HerdrStreamFrame[] = [];
  const mgr = new HerdrStreamManager(
    mockPool,
    () => {
      child = new PipeControlChild();
      return localClient(child);
    },
    async () => "/tmp/img",
    { terminationGraceMs: 20, shutdownDrainTimeoutMs: 100 },
  );
  mgr.setSink((frame) => frames.push(frame));
  return {
    mgr,
    child: () => {
      if (!child) throw new Error("control child not spawned");
      return child;
    },
    frames,
  };
};

const waitFor = async (cond: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("isHerdrBrokenPipeError", () => {
  it("classifies EPIPE / EIO / destroyed stream", () => {
    expect(isHerdrBrokenPipeError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(
      true,
    );
    expect(isHerdrBrokenPipeError(Object.assign(new Error("EIO"), { code: "EIO" }))).toBe(true);
    expect(
      isHerdrBrokenPipeError(
        Object.assign(new Error("Cannot call write after a stream was destroyed"), {
          code: "ERR_STREAM_DESTROYED",
        }),
      ),
    ).toBe(true);
    expect(isHerdrBrokenPipeError(new Error("ENOENT"))).toBe(false);
  });
});

describe("HerdrStreamManager control I/O hardening", () => {
  it("contains async stdin EPIPE without uncaughtException and closes the stream once", async () => {
    const { mgr, child, frames } = openManager();
    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    try {
      const opened = mgr.open({
        hostId: "local",
        terminalId: "pane-1",
        cols: 80,
        rows: 24,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const streamId = opened.streamId;

      // Production path: Node emits async "error" on the Writable after the
      // herdr control child dies mid-write — not on ChildProcess.
      child().sink.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

      await waitFor(() => frames.some((f) => f.type === "closed"), 500);

      const closed = frames.filter((f) => f.type === "closed");
      const errors = frames.filter((f) => f.type === "error");
      expect(closed).toHaveLength(1);
      expect(closed[0]?.reason).toBe("pipe_broken");
      expect(errors.some((f) => /pipe broken|EPIPE/i.test(f.message ?? ""))).toBe(true);
      expect(mgr.activeControlCount()).toBe(0);

      // Further writes fail closed — no second crash, no second closed frame.
      const again = mgr.input(streamId, Buffer.from("x").toString("base64"));
      expect(again.ok).toBe(false);
      expect(frames.filter((f) => f.type === "closed")).toHaveLength(1);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await mgr.drainOnQuit("test");
    }
  });

  it("sync write throw marks stdin broken and tears down once", async () => {
    const { mgr, child, frames } = openManager();

    const opened = mgr.open({
      hostId: "local",
      terminalId: "pane-sync",
      cols: 80,
      rows: 24,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Force the synchronous throw path (enqueueWrite try/catch). Some Node
    // versions surface destroyed-pipe as async error only; both paths must
    // converge on one closed frame.
    child().stdin.write = (): boolean => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    };
    const written = mgr.input(opened.streamId, Buffer.from("hi").toString("base64"));
    expect(written.ok).toBe(false);

    await waitFor(() => frames.some((f) => f.type === "closed"), 500);
    expect(frames.filter((f) => f.type === "closed")).toHaveLength(1);
    expect(mgr.activeControlCount()).toBe(0);

    await mgr.drainOnQuit("test");
  });

  it("detach after child death does not re-emit closed from a late EPIPE", async () => {
    const { mgr, child, frames } = openManager();

    const opened = mgr.open({
      hostId: "local",
      terminalId: "pane-detach",
      cols: 80,
      rows: 24,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Operator closes control (sends terminal.release) — stream is removed.
    const closed = mgr.close(opened.streamId, "client_close");
    expect(closed.ok).toBe(true);
    expect(frames.filter((f) => f.type === "closed")).toHaveLength(1);
    expect(frames.filter((f) => f.type === "closed")[0]?.reason).toBe("client_close");

    // Late async error from a racing release write must be swallowed (stream
    // already gone from the map).
    child().sink.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(frames.filter((f) => f.type === "closed")).toHaveLength(1);

    await mgr.drainOnQuit("test");
  });
});
