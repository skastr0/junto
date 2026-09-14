import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { CanvasDoc, TextNode } from "../src/shared/canvas";
import {
  LocalSessionHost,
} from "../src/main/vellum-command/term/local-host";
import { startTermControlServer } from "../src/main/vellum-command/term/control-server";
import { TermControlClient } from "../src/main/vellum-command/term/control-client";
import { TermControlTransportUncertainError } from "../src/main/vellum-command/term/control-client";
import { TerminalRouter } from "../src/main/vellum-command/term/router";
import {
  hostsSnapshot,
  setHostsSnapshot,
} from "../src/main/vellum-command/hosts/snapshot";
import { Scope } from "effect";
import { FLEET_UI_ENABLED } from "../src/shared/features";
import {
  bindManagedTerminalDriveForOverseer,
} from "../src/main/vellum-command/term/managed-drive-holder";
import { createManagedTerminalDrive } from "../src/main/vellum-command/term/drive/managed-drive-factory";
import {
  attachManagedTerminalDriveRuntime,
  type ManagedDriveHostEvent,
  type ManagedDriveSeatEvent,
} from "../src/main/vellum-command/term/drive/managed-drive-runtime";
import {
  makeOverseerNativeLive,
  type OverseerNativeLiveOptions,
} from "../src/main/vellum-command/overseer/native";
import type { TermPlane } from "../src/main/vellum-command/term/plane";
import { TerminalNodeDeleteService } from "../src/main/vellum-command/term/node-delete";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum-command/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum-command/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
  vi.useRealTimers();
});

const bootServer = async () => {
  setProcessIdentityMapForTests(makeProcessIdentityMap());
  setProcessEpochReaderForTests({
    snapshot: () => [{
      pid: 9001,
      processGroupId: 9000,
      sessionId: 7,
      startKey: "synthetic-9001",
    }],
  });
  // Short prefix: macOS unix socket paths cap near 104 chars.
  const home = mkdtempSync(join(tmpdir(), "vtq-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const host = new LocalSessionHost(
    makeFakeTerminalProcessAuthority(() => ({
      pid: 9001,
      output: "ready\r\n",
      exitOnSignal: "SIGTERM",
      echoWrites: "echo:",
    })).authority,
    { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 },
  );
  cleanups.push(async () => {
    await host.shutdownAll("test");
  });
  const server = await startTermControlServer(host, { home });
  cleanups.push(() => server.close());
  const client = await TermControlClient.connect({
    socketPath: server.socketPath,
    token: server.token,
    timeoutMs: 5_000,
  });
  cleanups.push(() => client.close());
  return { client };
};

describe("shared destination drive factory", () => {
  it("assembles one drive from evidence sources and delivers paste+CR", async () => {
    const writes: string[] = [];
    const drive = createManagedTerminalDrive({
      write: (_bindingId, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => true,
      seatState: () => "idle",
      onAttention: () => undefined,
      snapshot: () => ({ text: "❯", lines: ["❯"] }),
      composerVerdict: () => "empty",
      harnessFor: () => undefined,
    });
    await expect(
      drive.writePrompt("seat", "hello", { awaitTurnStart: false }),
    ).resolves.toBe(true);
    expect(writes).toHaveLength(2);
  });
});

describe("term control managedPrompt", () => {
  it("refuses explicitly when no destination drive is bound", async () => {
    const { client } = await bootServer();
    await expect(
      client.managedPrompt("bind-x", "hello"),
    ).rejects.toThrow(/no destination managed drive/);
  });

  it("delivers through the bound destination drive with queue policy", async () => {
    const calls: Array<{ bindingId: string; text: string; queueIfBusy: boolean }> = [];
    bindManagedTerminalDriveForOverseer({
      writePrompt: async (bindingId: string, text: string, options?: { queueIfBusy?: boolean }) => {
        calls.push({ bindingId, text, queueIfBusy: options?.queueIfBusy ?? true });
        return true;
      },
      interrupt: async (_bindingId: string) => true,
    } as unknown as import("../src/main/vellum-command/term/drive").ManagedTerminalDrive);
    const { client } = await bootServer();
    await expect(
      client.managedPrompt("bind-y", "do the thing", true),
    ).resolves.toBe(true);
    expect(calls).toEqual([{ bindingId: "bind-y", text: "do the thing", queueIfBusy: true }]);
  });

  it("rejects empty text without touching the drive", async () => {
    const { client } = await bootServer();
    await expect(client.managedPrompt("bind-y", "")).rejects.toThrow(
      /bindingId and text/,
    );
  });
});

const agent = (id: string, host: string): TextNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    host,
    terminal: {
      bindingId: `bind-${id}`,
      harness: "codex",
      launch: { kind: "harness", argv: ["codex"] },
    },
  },
});

const doc = (nodes: CanvasDoc["nodes"]): CanvasDoc => ({ nodes, edges: [] });

const live = (
  documents: ReadonlyArray<{ name: string; doc: CanvasDoc }>,
  extra: Partial<OverseerNativeLiveOptions> & {
    readonly managedPrompt?: (...args: Array<never>) => Promise<boolean | "uncertain">;
  } = {},
) => {
  const { managedPrompt: managedPromptOverride, ...rest } = extra;
  const managedPrompt =
    managedPromptOverride ?? (async () => true);
  const router = {
    isLocalHostId: (hostId: string | undefined | null) =>
      hostId === undefined || hostId === null || hostId.trim() === "" || hostId === "local",
    attach: vi.fn(async () => ({ ok: false, message: "no attach in test" })),
    release: vi.fn(async () => undefined),
    write: vi.fn(async () => false),
    resize: vi.fn(async () => false),
    managedPrompt: vi.fn(managedPrompt as (...args: unknown[]) => Promise<boolean | "uncertain">),
    get: async () => undefined,
    kill: async () => true,
    create: async (input: { bindingId: string }) => ({
      bindingId: input.bindingId,
      hostId: "local",
      status: "running",
      epoch: "e1",
      detached: true,
      createdAt: 1,
    }),
    deleteBinding: async () => true,
  };
  const termPlane = {
    router,
    host: {
      writeManagedSeat: vi.fn(() => true),
      resizeManagedSeat: vi.fn(() => true),
    },
    nodeDelete: undefined as unknown as TerminalNodeDeleteService,
  };
  termPlane.nodeDelete = new TerminalNodeDeleteService(router as never);
  return {
    native: makeOverseerNativeLive({
      termPlane: termPlane as unknown as TermPlane,
      chats: {} as never,
      captureApplicationPage: async () => ({ ok: false as const, unavailable: true as const, reason: "test" }),
      liveOverseerGrant: async () => true,
      listCanvasDocuments: async () => documents,
      occupySeat: async (_spec: unknown, signal: AbortSignal) => !signal.aborted,
      managedDrive: { writePrompt: vi.fn(async () => true), interrupt: vi.fn(async () => true) },
      ...rest,
    } as OverseerNativeLiveOptions),
    router,
  };
};

const runPrompt = (
  native: ReturnType<typeof makeOverseerNativeLive>,
  nodeId: string,
  text: string,
) =>
  Effect.runPromise(
    native.executeResult(
      { canvasName: "factory", nodeId: "overseer-1" },
      { operation: "agent.prompt" as never, args: { nodeId, text } },
    ),
  );

describe("overseer remote agent.prompt", () => {
  it("routes a remote seat through the destination managed op, never a raw lease write", async () => {
    const remoteAgent = agent("remote-a", "studio");
    const managedPrompt = vi.fn(async () => true);
    const { native, router } = live(
      [{ name: "factory", doc: doc([remoteAgent]) }],
      { managedPrompt },
    );
    const result = await runPrompt(native, "remote-a", "hello remote");
    expect(result.ok).toBe(true);
    expect(managedPrompt).toHaveBeenCalledWith(
      "bind-remote-a",
      "hello remote",
      false,
      "studio",
      expect.any(AbortSignal),
    );
    expect(router.write).not.toHaveBeenCalled();
    expect(router.attach).not.toHaveBeenCalled();
  });

  it("fails closed when the destination drive refuses", async () => {
    const remoteAgent = agent("remote-a", "studio");
    const { native } = live(
      [{ name: "factory", doc: doc([remoteAgent]) }],
      { managedPrompt: async () => false },
    );
    const result = await runPrompt(native, "remote-a", "hello remote");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("RuntimeDown");
  });

  it("surfaces transport uncertainty as a named outcome, never a false refusal", async () => {
    const remoteAgent = agent("remote-a", "studio");
    const { native } = live(
      [{ name: "factory", doc: doc([remoteAgent]) }],
      { managedPrompt: async () => "uncertain" as const },
    );
    const result = await runPrompt(native, "remote-a", "hello remote");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      delivered: false,
      uncertain: true,
      bindingId: "bind-remote-a",
    });
  });
});

describe("router managedPrompt transport", () => {
  const initialHosts = hostsSnapshot();
  const localHosts: LocalSessionHost[] = [];
  const routers: TerminalRouter[] = [];

  const makeRouter = (): TerminalRouter => {
    const local = new LocalSessionHost(
      makeFakeTerminalProcessAuthority(() => ({
        pid: undefined,
        exitOnSignal: false,
      })).authority,
      { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 },
    );
    localHosts.push(local);
    const router = new TerminalRouter(local);
    routers.push(router);
    setHostsSnapshot([
      ...initialHosts,
      {
        id: "studio",
        label: "Studio",
        kind: "remote",
        sshEndpoint: "studio.example",
        capabilities: ["terminal"],
      },
    ]);
    return router;
  };

  const installEntry = (
    router: TerminalRouter,
    managedPrompt: (...args: Array<never>) => Promise<boolean>,
  ) => {
    const spy = vi.fn(managedPrompt);
    (
      router as unknown as {
        remotes: Map<string, unknown>;
      }
    ).remotes.set("studio", {
      client: { isLive: () => true, managedPrompt: spy },
      forward: {},
      endpoint: "studio.example",
      generation: 1,
      scope: {},
      rootScope: Effect.runSync(Scope.make()),
      leaseMap: new Map(),
      reverseLease: new Map(),
    });
    return spy;
  };

  afterEach(async () => {
    for (const router of routers.splice(0)) router.beginShutdown();
    for (const host of localHosts.splice(0)) {
      await host.shutdownAll("test");
    }
    setHostsSnapshot(initialHosts);
  });

  // Entry-dependent routing needs the fleet dial path enabled.
  const fleetIt = it.runIf(FLEET_UI_ENABLED);

  const breakDial = (router: TerminalRouter): void => {
    (
      router as unknown as {
        connectRemote: () => Promise<never>;
      }
    ).connectRemote = async () => {
      throw new Error("no dial in test");
    };
  };

  fleetIt("revocation during entry setup sends nothing", async () => {
    const router = makeRouter();
    const spy = installEntry(router, async () => true);
    const controller = new AbortController();
    const flight = router.managedPrompt("b", "hi", false, "studio", controller.signal);
    controller.abort();
    await expect(flight).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("pre-aborted signal refuses before entry setup", async () => {
    const router = makeRouter();
    const spy = installEntry(router, async () => true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      router.managedPrompt("b", "hi", false, "studio", controller.signal),
    ).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  fleetIt("maps transport uncertainty distinctly from refusal", async () => {
    const router = makeRouter();
    const uncertainSpy = installEntry(router, async () => {
      throw new TermControlTransportUncertainError("term control timeout op=managedPrompt");
    });
    await expect(
      router.managedPrompt("b", "hi", false, "studio"),
    ).resolves.toBe("uncertain");
    expect(uncertainSpy).toHaveBeenCalledTimes(1);
  });

  fleetIt("maps destination refusal to false", async () => {
    const router = makeRouter();
    installEntry(router, async () => {
      throw new Error("no destination managed drive; refusing raw write");
    });
    await expect(router.managedPrompt("b", "hi", false, "studio")).resolves.toBe(false);
  });

  it("refuses when no route entry exists", async () => {
    const router = makeRouter();
    breakDial(router);
    await expect(router.managedPrompt("b", "hi", false, "studio")).resolves.toBe(false);
  });
});

describe("snapshot-unknown evidence", () => {
  const evidenceDrive = (controls: {
    writes: string[];
    attention: string[];
    getSnapshot: () => { text: string; lines: readonly string[] } | undefined;
  }) =>
    createManagedTerminalDrive({
      write: (_bindingId, data) => {
        controls.writes.push(data);
        return true;
      },
      isSeatIdle: () => true,
      seatState: () => "idle",
      onAttention: (_bindingId, reason) => {
        controls.attention.push(reason);
      },
      snapshot: () => controls.getSnapshot(),
      composerVerdict: () => "empty",
      harnessFor: () => "codex",
    });

  it("accepted paste then vanished snapshot stays unresolved with no recovery writes", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const attention: string[] = [];
    let present = true;
    const drive = evidenceDrive({
      writes,
      attention,
      getSnapshot: () => (present ? { text: "❯", lines: ["❯"] } : undefined),
    });
    const first = drive.writePrompt("seat", "hello");
    await vi.advanceTimersByTimeAsync(120);
    present = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toBe(false);
    expect(attention).toContain("prompt-stalled");
    // Paste + recipe CR only: no chip CR, no recovery CR into the unknown.
    expect(writes).toHaveLength(2);
    await expect(drive.writePrompt("seat", "retry")).resolves.toBe(false);
    expect(writes).toHaveLength(2);
  });

  it("present snapshot with text gone still receipts the submit", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const attention: string[] = [];
    const drive = evidenceDrive({
      writes,
      attention,
      getSnapshot: () => ({ text: "❯", lines: ["❯"] }),
    });
    const first = drive.writePrompt("seat", "hello");
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toBe(true);
    expect(writes).toHaveLength(2);
  });
});

describe("shared runtime lifecycle", () => {
  it("binding replacement during settle stops the old CR; working resolves the current prompt", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let lines: readonly string[] = ["❯"];
    const drive = createManagedTerminalDrive({
      write: (_bindingId, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => true,
      seatState: () => "idle",
      onAttention: () => undefined,
      snapshot: () => ({ text: lines.join("\n"), lines }),
      composerVerdict: () => "empty",
      harnessFor: () => "codex",
    });
    let hostListener!: (event: ManagedDriveHostEvent) => void;
    let seatListener!: (event: ManagedDriveSeatEvent) => void;
    const unsubscribed = { host: false, seat: false, composer: false };
    const dispose = attachManagedTerminalDriveRuntime(drive, {
      subscribeHostEvents: (listener) => {
        hostListener = listener;
        return () => {
          unsubscribed.host = true;
        };
      },
      subscribeSeatState: (listener) => {
        seatListener = listener;
        return () => {
          unsubscribed.seat = true;
        };
      },
      subscribeComposerEmpty: () => () => {
        unsubscribed.composer = true;
      },
      harnessFor: () => "codex",
      snapshotText: () => lines.join("\n"),
    });
    const first = drive.writePrompt("seat", "old");
    await vi.advanceTimersByTimeAsync(10);
    hostListener({ kind: "session", bindingId: "seat", exited: false, running: true });
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toBe(false);
    // Paste only: the submit CR never reaches the replacement generation.
    expect(writes).toHaveLength(1);
    const second = drive.writePrompt("seat", "new");
    await vi.advanceTimersByTimeAsync(120);
    seatListener({ bindingId: "seat", state: "working" });
    await expect(second).resolves.toBe(true);
    expect(writes).toHaveLength(3);
    dispose();
    expect(unsubscribed).toEqual({ host: true, seat: true, composer: true });
  });
});
