import { Effect, Exit } from "effect";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  HerdrStreamManager,
  type HerdrClientIo,
  type HerdrSpawnedClient,
  type ObservePoolHooks,
} from "../src/main/vellum/herdr/stream";
import { makeTerminalSessions } from "../src/main/vellum/term/sessions";
import type { AppProcessSignalReceipt } from "../src/main/vellum/app-process-plane";
import {
  productStatusFromSessionPhase,
  SessionPhase,
  sessionPhaseAllowsWrite,
  sessionPhaseFromControlIo,
  ControlIoPhase,
} from "../src/shared/terminal-session-domain";

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

class FakeChild extends EventEmitter implements HerdrClientIo {
  written: string[] = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    },
    on: (): unknown => undefined,
  };
  readonly stdout = {
    setEncoding: (): void => undefined,
    on: (): unknown => undefined,
  };
  readonly stderr = {
    setEncoding: (): void => undefined,
    on: (): unknown => undefined,
  };
  kill(): boolean {
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

const localClient = (child: FakeChild): HerdrSpawnedClient => ({
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

describe("session phase product mapping", () => {
  it("maps Opening/Live/Broken/Closed to wire status", () => {
    expect(productStatusFromSessionPhase(SessionPhase.Opening({ surface: "native" }))).toBe(
      "starting",
    );
    expect(productStatusFromSessionPhase(SessionPhase.Live({ surface: "native" }))).toBe(
      "running",
    );
    expect(
      productStatusFromSessionPhase(
        SessionPhase.Broken({ surface: "native", reason: "pipe" }),
      ),
    ).toBe("running");
    expect(
      productStatusFromSessionPhase(
        SessionPhase.Closed({ surface: "herdr-control", reason: "exit" }),
      ),
    ).toBe("exited");
  });

  it("lifts control I/O phase into session phase", () => {
    expect(sessionPhaseFromControlIo(ControlIoPhase.Live())._tag).toBe("Live");
    expect(
      sessionPhaseFromControlIo(ControlIoPhase.Broken({ reason: "pipe" }))._tag,
    ).toBe("Broken");
    expect(sessionPhaseAllowsWrite(SessionPhase.Live({ surface: "native" }))).toBe(true);
    expect(
      sessionPhaseAllowsWrite(SessionPhase.Broken({ surface: "native", reason: "io" })),
    ).toBe(false);
  });
});

describe("TerminalSessions Effect service", () => {
  let mgr: HerdrStreamManager | undefined;

  afterEach(async () => {
    if (mgr) await mgr.drainOnQuit("test");
    mgr = undefined;
  });

  it("openScoped yields handle and scope release detaches", async () => {
    let child: FakeChild | undefined;
    mgr = new HerdrStreamManager(
      mockPool,
      () => {
        child = new FakeChild();
        return localClient(child);
      },
      async () => "/tmp/img",
      { terminationGraceMs: 20, shutdownDrainTimeoutMs: 100 },
    );
    const sessions = makeTerminalSessions(mgr);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* sessions.openScoped({
          hostId: "local",
          terminalId: "pane-a",
          cols: 80,
          rows: 24,
        });
        expect(handle.streamId.length).toBeGreaterThan(0);
        expect(sessions.activeControlCount()).toBe(1);
        yield* sessions.inputText(handle.streamId, "hello");
        expect(child?.written.some((w) => w.includes("terminal.input"))).toBe(true);
        return handle.streamId;
      }),
    );

    const streamId = await Effect.runPromise(program);
    // Scope closed → detach ran
    expect(mgr.activeControlCount()).toBe(0);
    // Further writes fail closed
    const again = await Effect.runPromise(Effect.result(sessions.inputText(streamId, "x")));
    expect(again._tag).toBe("Failure");
  });

  it("openProduct is the unscoped IPC path and closeProduct detaches", async () => {
    mgr = new HerdrStreamManager(
      mockPool,
      () => localClient(new FakeChild()),
      async () => "/tmp/img",
      { terminationGraceMs: 20, shutdownDrainTimeoutMs: 100 },
    );
    const sessions = makeTerminalSessions(mgr);
    const opened = sessions.openProduct({
      hostId: "local",
      terminalId: "pane-ipc",
      cols: 80,
      rows: 24,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok || !opened.streamId) return;
    expect(sessions.activeControlCount()).toBe(1);
    expect(sessions.inputTextProduct(opened.streamId, "hi").ok).toBe(true);
    sessions.closeProduct(opened.streamId, "client_close");
    expect(sessions.activeControlCount()).toBe(0);
  });

  it("spawn failure is TerminalSpawnError", async () => {
    mgr = new HerdrStreamManager(
      mockPool,
      () => {
        throw new Error("herdr binary missing");
      },
      async () => "/tmp/img",
    );
    const sessions = makeTerminalSessions(mgr);
    const exit = await Effect.runPromiseExit(
      sessions.open({
        hostId: "local",
        terminalId: "gone",
        cols: 80,
        rows: 24,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toMatch(/TerminalSpawnError|herdr binary missing|failed to spawn/);
    }
  });
});
