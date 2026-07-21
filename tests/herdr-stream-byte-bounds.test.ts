import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BUFFER_BYTES, feedNdjson } from "../src/main/vellum/herdr/ndjson";
import {
  HerdrStreamManager,
  type HerdrProcessLike,
  type HerdrStreamFrame,
  type ObservePoolHooks,
} from "../src/main/vellum/herdr/stream";
import {
  HerdrObservePool,
  type ObserveChildLike,
  type ObserveSpawnFn,
} from "../src/main/vellum/herdr/observe-pool";
import { LocalMirrorTransport } from "../src/main/vellum/herdr/mirror-transport";

const waitFor = async (cond: () => boolean, ms = 4_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

// --- feedNdjson byte cap -------------------------------------------------

describe("feedNdjson byte cap", () => {
  it("fires onOverflow with the buffered byte count and resets the buffer", () => {
    const lines: string[] = [];
    let overflowed: number | undefined;
    const remainder = feedNdjson("", "a".repeat(50), (l) => lines.push(l), {
      maxBufferBytes: 32,
      onOverflow: (bytes) => {
        overflowed = bytes;
      },
    });
    expect(overflowed).toBe(50);
    expect(remainder).toBe("");
    expect(lines).toEqual([]);
  });

  it("does not fire for a remainder at or under the cap", () => {
    const onOverflow = vi.fn();
    const remainder = feedNdjson("", "a".repeat(32), () => {}, { maxBufferBytes: 32, onOverflow });
    expect(onOverflow).not.toHaveBeenCalled();
    expect(remainder).toBe("a".repeat(32));
  });

  it("still emits complete lines before the trailing remainder overflows", () => {
    const lines: string[] = [];
    const onOverflow = vi.fn();
    feedNdjson("", `first\n${"x".repeat(40)}`, (l) => lines.push(l), { maxBufferBytes: 32, onOverflow });
    expect(lines).toEqual(["first"]);
    expect(onOverflow).toHaveBeenCalledWith(40);
  });

  it("defaults to an 8 MiB cap when no options are given", () => {
    expect(DEFAULT_MAX_BUFFER_BYTES).toBe(8 * 1024 * 1024);
    const remainder = feedNdjson("", "small", () => {});
    expect(remainder).toBe("small");
  });
});

// --- shared fakes ----------------------------------------------------------

const mockPool: ObservePoolHooks = {
  ensureObserve: () => ({ pooled: true }),
  retainedFrames: () => ({ frames: [] }),
  pauseForControl: () => undefined,
  clearRetention: () => undefined,
  releaseObserve: () => undefined,
  stopAll: () => undefined,
};

/** EventEmitter-based control child so `child.on("close"/"error")` actually fires. */
class FakeControlChild extends EventEmitter implements HerdrProcessLike {
  killedSignal: NodeJS.Signals | undefined;
  readonly stdin = {
    write: (_chunk: string): boolean => true,
  };
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });
  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignal = signal ?? "SIGTERM";
    return true;
  }
}

/**
 * Control child whose stdin is a real PassThrough — write() return value and
 * `drain` come from genuine Node stream backpressure, not a hand-rolled mock.
 * `rawChunks` records exactly what was handed to write(), in call order,
 * independent of the PassThrough's own (async) 'data' delivery timing.
 */
class CapturingStdinChild extends EventEmitter implements HerdrProcessLike {
  readonly sink: PassThrough;
  readonly rawChunks: string[] = [];
  writeCalls = 0;
  readonly stdin: HerdrProcessLike["stdin"];
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });

  constructor(highWaterMark = 16 * 1024) {
    super();
    this.sink = new PassThrough({ highWaterMark });
    this.stdin = {
      write: (chunk: string): boolean => {
        this.writeCalls += 1;
        this.rawChunks.push(chunk);
        return this.sink.write(chunk, "utf8");
      },
      once: (event: "drain", listener: () => void): unknown => this.sink.once(event, listener),
    };
  }

  kill(): boolean {
    return true;
  }

  /** Start consuming the readable side so backpressure eventually clears —
   * without this, a paused PassThrough's writable buffer never drains. */
  drain(): void {
    this.sink.resume();
    this.sink.on("data", () => undefined);
  }

  text(): string {
    return this.rawChunks.join("");
  }
}

// --- inbound: control stream overflow (stream.ts) --------------------------

describe("HerdrStreamManager inbound NDJSON overflow", () => {
  it("kills the control child and surfaces error+closed, then rejects further input", () => {
    let child: FakeControlChild | undefined;
    const mgr = new HerdrStreamManager(
      mockPool,
      () => {
        child = new FakeControlChild();
        return child;
      },
      async () => "/tmp/img",
    );
    const events: HerdrStreamFrame[] = [];
    mgr.setSink((f) => events.push(f));

    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok || !child) return;

    // Wedged child: an unterminated chunk past the default 8 MiB cap.
    child.stdout.emit("data", "x".repeat(DEFAULT_MAX_BUFFER_BYTES + 1));

    expect(child.killedSignal).toBe("SIGTERM");
    expect(events[0]).toMatchObject({ type: "error" });
    expect(events[0]!.message).toMatch(/max NDJSON buffer/);

    // The killed process eventually exits — normal close handling follows.
    child.emit("close", null);
    expect(events[1]).toMatchObject({ type: "closed" });
    expect(mgr.inputText(opened.streamId, "x").ok).toBe(false);
  });
});

// --- inbound: observe pool overflow (observe-pool.ts) -----------------------

describe("HerdrObservePool inbound NDJSON overflow", () => {
  it("kills the child and marks the entry stale — a later ensureObserve respawns it", () => {
    const children: FakeControlChild[] = [];
    const spawnFn: ObserveSpawnFn = () => {
      const child = new FakeControlChild();
      children.push(child);
      return child as unknown as ObserveChildLike;
    };
    const pool = new HerdrObservePool({ spawnFn });
    pool.ensureObserve({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    const first = children[0]!;

    first.stdout.emit("data", "x".repeat(DEFAULT_MAX_BUFFER_BYTES + 1));

    expect(first.killedSignal).toBe("SIGTERM");
    expect(pool.entryState("t1")).toEqual({ live: false, stale: true });

    expect(pool.ensureObserve({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 })).toEqual({
      pooled: true,
    });
    expect(children.length).toBe(2);
    expect(pool.entryState("t1")?.live).toBe(true);
  });
});

// --- outbound: chunked writes on the control stream (stream.ts) ------------

describe("HerdrStreamManager outbound write chunking", () => {
  it("a small command is written as a single stdin write", () => {
    const child = new CapturingStdinChild();
    const mgr = new HerdrStreamManager(mockPool, () => child, async () => "/tmp/img");
    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const res = mgr.resize(opened.streamId, 100, 30);
    expect(res.ok).toBe(true);
    expect(child.writeCalls).toBe(1);
    expect(child.text()).toBe(`${JSON.stringify({ type: "terminal.resize", cols: 100, rows: 30 })}\n`);
  });

  it("a 1 MiB+ outbound payload is sliced into multiple writes and arrives intact and in order", async () => {
    const child = new CapturingStdinChild(16 * 1024);
    const mgr = new HerdrStreamManager(mockPool, () => child, async () => "/tmp/img");
    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const bigBase64 = "P".repeat(1.5 * 1024 * 1024); // well over the 256 KiB slice size
    const res = mgr.input(opened.streamId, bigBase64);
    expect(res.ok).toBe(true);
    child.drain(); // let backpressure clear so the chunked write completes

    const expectedLine = `${JSON.stringify({ type: "terminal.input", bytes: bigBase64 })}\n`;
    await waitFor(() => child.text().length >= expectedLine.length);

    expect(child.text()).toBe(expectedLine);
    expect(child.writeCalls).toBeGreaterThan(1);
  });

  it("interleaved ordering is preserved under backpressure — a resize issued mid-paste writes only after the paste completes", async () => {
    const child = new CapturingStdinChild(16 * 1024);
    const mgr = new HerdrStreamManager(mockPool, () => child, async () => "/tmp/img");
    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const bigBase64 = "Q".repeat(600 * 1024);
    const pasteRes = mgr.input(opened.streamId, bigBase64);
    expect(pasteRes.ok).toBe(true);

    // Issued while the paste is still mid-flight (backpressured on the sink).
    const resizeRes = mgr.resize(opened.streamId, 111, 33);
    expect(resizeRes.ok).toBe(true);

    const resizeLine = `${JSON.stringify({ type: "terminal.resize", cols: 111, rows: 33 })}\n`;
    // Not written yet — queued behind the still-in-flight paste, not raced ahead.
    expect(child.text()).not.toContain(resizeLine);

    child.drain();
    await waitFor(() => child.text().includes(resizeLine));

    const pasteLine = `${JSON.stringify({ type: "terminal.input", bytes: bigBase64 })}\n`;
    expect(child.text()).toBe(pasteLine + resizeLine);
    expect(child.writeCalls).toBeGreaterThan(2);
  });
});

// --- mirror-transport: same byte cap on its own line feed -------------------

describe("LocalMirrorTransport NDJSON buffer overflow", () => {
  it("destroys the socket and rejects the pending request on an unterminated overflow", async () => {
    const sockPath = join(tmpdir(), `vm-overflow-${process.pid}-${Date.now()}.sock`);
    let server: Server | undefined;
    try {
      server = createServer((sock) => {
        sock.on("data", () => {
          sock.write("x".repeat(DEFAULT_MAX_BUFFER_BYTES + 1));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(sockPath, () => resolve());
      });

      const transport = new LocalMirrorTransport(sockPath);
      await expect(transport.request("session.snapshot", {})).rejects.toThrow(/NDJSON buffer/);
    } finally {
      server?.close();
      try {
        unlinkSync(sockPath);
      } catch {
        // gone
      }
    }
  });
});
