import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  admitChildProcess: vi.fn(),
  signalOwned: vi.fn(),
  releaseOwned: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("../src/main/vellum/process-signal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/vellum/process-signal")>()),
  admitChildProcess: mocks.admitChildProcess,
  signalOwned: mocks.signalOwned,
  releaseOwned: mocks.releaseOwned,
}));

import { createAppProcessPlane } from "../src/main/vellum/app-process-plane";
import type { JsonRpcId, SpawnFn } from "../src/main/vellum/chat/acp-client";
import {
  ChatService,
  ChatShutdownUncleanError,
  requireCleanChatShutdown,
} from "../src/main/vellum/chat/service";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  readonly pid = 42_101;
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.written.push(String(chunk)));
  }

  close(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

interface FakeOwned {
  readonly sink: { readonly kill: (signal?: NodeJS.Signals) => unknown };
  released: boolean;
}

const flush = async (ticks = 12): Promise<void> => {
  for (let index = 0; index < ticks; index++) await Promise.resolve();
};

const waitForWrites = async (child: FakeChild, length: number): Promise<void> => {
  for (let index = 0; index < 20 && child.written.length < length; index++) {
    await flush(1);
  }
};

const lastSentId = (child: FakeChild): JsonRpcId =>
  (JSON.parse(child.written.at(-1)!) as { readonly id: JsonRpcId }).id;

const respondOk = (child: FakeChild, id: JsonRpcId, result: unknown): void => {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  mocks.admitChildProcess.mockReset();
  mocks.signalOwned.mockReset();
  mocks.releaseOwned.mockReset();
  mocks.admitChildProcess.mockImplementation(
    (input: { readonly child: FakeOwned["sink"] }): FakeOwned => ({
      sink: input.child,
      released: false,
    }),
  );
  mocks.signalOwned.mockImplementation(
    (owned: FakeOwned, signal: NodeJS.Signals) => {
      if (owned.released) {
        return {
          attempted: false,
          decision: { ok: false, reason: "handle-not-registered" },
          via: "none",
        };
      }
      const accepted = owned.sink.kill(signal) !== false;
      return accepted
        ? {
            attempted: true,
            decision: { ok: true, mode: "child" },
            via: "child.kill",
          }
        : {
            attempted: false,
            decision: { ok: false, reason: "child-signal-refused" },
            via: "none",
          };
    },
  );
  mocks.releaseOwned.mockImplementation((owned: FakeOwned) => {
    owned.released = true;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("local ACP central process ownership", () => {
  it("retains one wedged lease through Chat/Hermes failure and the later app drain", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const processPlane = createAppProcessPlane({
      termGraceMs: 10,
      killGraceMs: 15,
    });
    let spawnedLease: ReturnType<typeof processPlane.spawnChild> | undefined;
    const spawnAcp: SpawnFn = () => {
      const lease = processPlane.spawnChild({
        source: "hermes-acp:default",
        purpose: "local ACP session for default",
        command: "hermes",
        args: ["acp"],
      });
      spawnedLease = lease;
      return { kind: "local-process", lease, processPlane };
    };
    const chat = new ChatService(spawnAcp);

    const opening = chat.chatOpen("local:default");
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await waitForWrites(child, 2);
    respondOk(child, lastSentId(child), {
      sessionId: "session-central-plane",
      models: { availableModels: [] },
    });
    await expect(opening).resolves.toMatchObject({ ok: true });

    const chatShutdown = chat.closeAll();
    await vi.advanceTimersByTimeAsync(4_000);
    const chatResult = await chatShutdown;
    expect(chatResult).toEqual({
      clean: false,
      teardowns: [{
        kind: "bounded",
        termAttempted: true,
        killAttempted: true,
      }],
    });
    expect(() => requireCleanChatShutdown(chatResult)).toThrow(
      ChatShutdownUncleanError,
    );
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    const appDrain = processPlane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(appDrain).resolves.toMatchObject({
      clean: false,
      stragglers: [{
        generation: 1,
        source: "hermes-acp:default",
        purpose: "local ACP session for default",
        mode: "child",
        state: "running",
        term: {
          signal: "SIGTERM",
          reason: "ACP generation teardown",
          attempted: true,
        },
        kill: {
          signal: "SIGKILL",
          reason: "ACP generation teardown escalation",
          attempted: true,
        },
      }],
    });
    // The central plane owns one coalesced TERM/KILL phase per lease. Its
    // drain reuses the ACP receipts instead of issuing duplicate signals.
    expect(mocks.signalOwned).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(mocks.releaseOwned).not.toHaveBeenCalled();

    child.close(null, "SIGKILL");
    await expect(spawnedLease!.io.closed).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
    await flush();
    await expect(processPlane.drainOnQuit()).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
  });
});
