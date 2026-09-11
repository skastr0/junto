import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Result, ManagedRuntime } from "effect";
import {
  browserProfileQuarantinePath,
  BrowserProfileStorageError,
  makeBrowserProfileStorageLifecycle,
  type BrowserProfileStorageCapabilityControl,
  type BrowserProfileStorageDependencies,
  type BrowserProfileStorageDirectory,
  type BrowserProfileStoragePlatform,
  type BrowserProfileStorageSession,
  type BrowserProfileStorageSessionControl,
} from "../src/main/vellum-command/browser/profile-storage";
import { makeBrowserProfileGate, type BrowserProfileGate } from "../src/main/vellum-command/browser/profile-gate";
import {
  makeBrowserProfileService,
  type BrowserProfilePendingWipe,
} from "../src/main/vellum-command/browser/profiles";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { StateEngine } from "../src/main/vellum-command/state/service";
import type {
  BrowserProfileQuiescenceSummary,
  BrowserResult,
} from "../src/main/vellum-command/browser/sessions";

const WIPE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_WIPE_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE = "personal";
const PARTITION = "persist:vellum-profile-personal";

interface Layout {
  readonly root: string;
  readonly userDataPath: string;
  readonly sessionDataPath: string;
  readonly storagePath: string;
}

interface FakeSession extends BrowserProfileStorageSession {
  storagePath: string | null;
  persistent: boolean;
  failAt: string | undefined;
  pendingAt: string | undefined;
  pendingOperation: Promise<void> | undefined;
}

interface Harness {
  readonly calls: string[];
  readonly gate: BrowserProfileGate;
  readonly session: FakeSession;
  readonly platform: BrowserProfileStoragePlatform;
  readonly sessions: BrowserProfileStorageSessionControl;
  readonly capabilities: BrowserProfileStorageCapabilityControl;
  readonly sessionCounts: Record<string, number>;
  readonly capabilityCounts: Record<string, number>;
  readonly sessionPartitionCalls: () => number;
  readonly setSession: (session: BrowserProfileStorageSession) => void;
  readonly setRoots: (roots: { readonly userDataPath: string; readonly sessionDataPath: string }) => void;
}

describe("browser profile storage lifecycle", () => {
  let cleanupRoot = "";
  let stateRuntime:
    | ManagedRuntime.ManagedRuntime<StateEngine, unknown>
    | undefined;

  afterEach(async () => {
    await stateRuntime?.dispose();
    stateRuntime = undefined;
    if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
    cleanupRoot = "";
  });

  const createLayout = async (storageName = "exact-electron-storage"): Promise<Layout> => {
    cleanupRoot = await realpath(await mkdtemp(join(tmpdir(), "vellum-profile-storage-")));
    const userDataPath = join(cleanupRoot, "User Data");
    const sessionDataPath = join(userDataPath, "Session Data");
    const storagePath = join(sessionDataPath, "Partitions", storageName);
    await mkdir(storagePath, { recursive: true, mode: 0o700 });
    return { root: cleanupRoot, userDataPath, sessionDataPath, storagePath };
  };

  const makeSession = (layout: Layout, calls: string[]): FakeSession => ({
    storagePath: layout.storagePath,
    persistent: true,
    failAt: undefined,
    pendingAt: undefined,
    pendingOperation: undefined,
    getStoragePath() {
      calls.push("getStoragePath");
      if (this.failAt === "getStoragePath") throw new Error("private storage path");
      return this.storagePath;
    },
    isPersistent() {
      calls.push("isPersistent");
      if (this.failAt === "isPersistent") throw new Error("private session state");
      return this.persistent;
    },
    flushStorageData() {
      calls.push("flushStorageData");
      if (this.failAt === "flushStorageData") throw new Error("private storage path");
      if (this.pendingAt === "flushStorageData") return this.pendingOperation;
    },
    async closeAllConnections() {
      calls.push("closeAllConnections");
      if (this.failAt === "closeAllConnections") throw new Error("private connection data");
      if (this.pendingAt === "closeAllConnections") await this.pendingOperation;
    },
    async clearData() {
      calls.push("clearData");
      if (this.failAt === "clearData") throw new Error("private cookie data");
      if (this.pendingAt === "clearData") await this.pendingOperation;
    },
    async clearAuthCache() {
      calls.push("clearAuthCache");
      if (this.failAt === "clearAuthCache") throw new Error("private auth data");
      if (this.pendingAt === "clearAuthCache") await this.pendingOperation;
    },
    async clearCache() {
      calls.push("clearCache");
      if (this.failAt === "clearCache") throw new Error("private cache data");
      if (this.pendingAt === "clearCache") await this.pendingOperation;
    },
  });

  const makeHarness = (
    layout: Layout,
    completion: BrowserResult<BrowserProfileQuiescenceSummary> = {
      ok: true,
      data: {
        pendingOpensInvalidated: 1,
        sessionsDestroyed: 2,
        viewsDestroyed: 2,
      },
    },
  ): Harness => {
    const calls: string[] = [];
    const gate = makeBrowserProfileGate();
    const session = makeSession(layout, calls);
    let currentSession: BrowserProfileStorageSession = session;
    let currentRoots = {
      userDataPath: layout.userDataPath,
      sessionDataPath: layout.sessionDataPath,
    };
    let sessionPartitionCalls = 0;
    const platform: BrowserProfileStoragePlatform = {
      currentRoots: () => {
        calls.push("currentRoots");
        return currentRoots;
      },
      sessionForPartition: (partition) => {
        calls.push(`sessionForPartition:${partition}`);
        sessionPartitionCalls += 1;
        return currentSession;
      },
    };
    const sessionCounts: Record<string, number> = { personal: 2, work: 3 };
    const sessions: BrowserProfileStorageSessionControl = {
      beginProfileQuiescence: (profile) => {
        calls.push(`quiesce:${profile}`);
        const begun = gate.begin(profile);
        if (!begun.ok) {
          return {
            ok: false,
            code: "resource_exhausted",
            message: "profile unavailable",
          };
        }
        const destroyed = sessionCounts[profile] ?? 0;
        sessionCounts[profile] = 0;
        return {
          ok: true,
          data: {
            block: begun.data,
            completion: Promise.resolve().then(() => {
              calls.push("physicalDestruction");
              return completion.ok
                ? {
                    ok: true,
                    data: {
                      ...completion.data,
                      sessionsDestroyed: destroyed,
                      viewsDestroyed: destroyed,
                    },
                  }
                : completion;
            }),
          },
        };
      },
    };
    const capabilityCounts: Record<string, number> = { personal: 2, work: 4 };
    const capabilities: BrowserProfileStorageCapabilityControl = {
      revokeByProfile: (profile, reason) => {
        calls.push(`revoke:${profile}:${reason}`);
        const revoked = capabilityCounts[profile] ?? 0;
        capabilityCounts[profile] = 0;
        return revoked;
      },
    };
    return {
      calls,
      gate,
      session,
      platform,
      sessions,
      capabilities,
      sessionCounts,
      capabilityCounts,
      sessionPartitionCalls: () => sessionPartitionCalls,
      setSession: (next) => {
        currentSession = next;
      },
      setRoots: (next) => {
        currentRoots = next;
      },
    };
  };

  const lifecycleFor = (
    harness: Harness,
    overrides: Partial<BrowserProfileStorageDependencies> = {},
  ) =>
    makeBrowserProfileStorageLifecycle({
      platform: harness.platform,
      sessions: harness.sessions,
      capabilities: harness.capabilities,
      profileGate: harness.gate,
      ...overrides,
    });

  const pendingFor = (
    layout: Layout,
    stage: BrowserProfilePendingWipe["stage"],
    overrides: Partial<BrowserProfilePendingWipe> = {},
  ): BrowserProfilePendingWipe =>
    Object.freeze({
      wipeId: WIPE_ID,
      profileId: PROFILE,
      partition: PARTITION,
      requestedAt: "2026-07-17T12:00:00.000Z",
      stage,
      userDataPath: layout.userDataPath,
      sessionDataPath: layout.sessionDataPath,
      storagePath: layout.storagePath,
      ...overrides,
    });

  const preparePending = async (
    layout: Layout,
    harness: Harness,
    lifecycle = lifecycleFor(harness),
  ) => {
    const paths = await lifecycle.prepare({
      wipeId: WIPE_ID,
      profileId: PROFILE,
      partition: PARTITION,
    });
    return {
      lifecycle,
      pending: pendingFor(layout, "live_clear_pending", paths),
    };
  };

  const expectStorageError = async (
    operation: Promise<unknown>,
    code: BrowserProfileStorageError["code"],
  ): Promise<BrowserProfileStorageError> => {
    try {
      await operation;
      throw new Error("expected browser profile storage failure");
    } catch (error) {
      if (!(error instanceof BrowserProfileStorageError)) throw error;
      expect(error.code).toBe(code);
      return error;
    }
  };

  it("prepares only the exact persistent Electron session path and validated app roots", async () => {
    const layout = await createLayout("not-derived-from-partition-name");
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness);

    const paths = await lifecycle.prepare({
      wipeId: WIPE_ID,
      profileId: PROFILE,
      partition: PARTITION,
    });

    expect(paths).toEqual({
      storagePath: layout.storagePath,
      userDataPath: layout.userDataPath,
      sessionDataPath: layout.sessionDataPath,
    });
    expect(Object.isFrozen(paths)).toBe(true);
    expect(harness.calls).toEqual([
      "currentRoots",
      `sessionForPartition:${PARTITION}`,
      "isPersistent",
      "getStoragePath",
    ]);
  });

  it("publishes lifecycle admission before a platform seam can re-enter shutdown", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    let lifecycle!: ReturnType<typeof makeBrowserProfileStorageLifecycle>;
    let reentrantDrain: ReturnType<typeof lifecycle.drainOnQuit> | undefined;
    const platform: BrowserProfileStoragePlatform = {
      ...harness.platform,
      currentRoots: () => {
        reentrantDrain ??= lifecycle.drainOnQuit();
        return harness.platform.currentRoots();
      },
    };
    lifecycle = lifecycleFor(harness, {
      platform,
      liveClearAggregateTimeoutMs: 100,
    });

    await lifecycle.prepare({ wipeId: WIPE_ID, profileId: PROFILE, partition: PARTITION });
    if (reentrantDrain === undefined) throw new Error("shutdown did not re-enter");
    const receipt = await reentrantDrain;

    expect(receipt).toMatchObject({
      epoch: 1,
      clean: true,
      operations: ["prepare"],
      settled: 1,
      fulfilled: 1,
      rejected: 0,
      timedOut: false,
      activeOperations: [],
      activeRawClearOperations: [],
    });
    const shutdownBlocked = await expectStorageError(
      lifecycle.prepare({ wipeId: SECOND_WIPE_ID, profileId: PROFILE, partition: PARTITION }),
      "gate_blocked",
    );
    expect(shutdownBlocked.retryable).toBe(false);
  });

  it("rejects a non-persistent Electron Session before journaling paths", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    harness.session.persistent = false;

    const error = await expectStorageError(
      lifecycleFor(harness).prepare({
        wipeId: WIPE_ID,
        profileId: PROFILE,
        partition: PARTITION,
      }),
      "session_not_persistent",
    );

    expect(error.retryable).toBe(false);
    expect(harness.gate.disposition(PROFILE)).toBe("open");
  });

  it("supports a persistent partition whose storage target and parent do not exist yet", async () => {
    const layout = await createLayout();
    await rm(dirname(layout.storagePath), { recursive: true });
    const harness = makeHarness(layout);
    const { lifecycle, pending } = await preparePending(layout, harness);
    harness.calls.length = 0;

    const outcome = await lifecycle.executeLive(pending);

    expect(outcome).toEqual({ status: "restart_delete_pending" });
    expect(harness.calls).toContain("flushStorageData");
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("bounds unjournaled prepare state to one replaceable record", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness);
    const firstPaths = await lifecycle.prepare({
      wipeId: WIPE_ID,
      profileId: PROFILE,
      partition: PARTITION,
    });
    const secondPaths = await lifecycle.prepare({
      wipeId: SECOND_WIPE_ID,
      profileId: PROFILE,
      partition: PARTITION,
    });

    await expectStorageError(
      lifecycle.executeLive(
        pendingFor(layout, "live_clear_pending", { wipeId: WIPE_ID, ...firstPaths }),
      ),
      "path_changed",
    );
    const outcome = await lifecycle.executeLive(
      pendingFor(layout, "live_clear_pending", {
        wipeId: SECOND_WIPE_ID,
        ...secondPaths,
      }),
    );

    expect(outcome).toEqual({ status: "restart_delete_pending" });
  });

  it("invalidates stale prepared authorization when a later prepare attempt fails", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness);
    const firstPaths = await lifecycle.prepare({
      wipeId: WIPE_ID,
      profileId: PROFILE,
      partition: PARTITION,
    });
    harness.session.persistent = false;

    await expectStorageError(
      lifecycle.prepare({
        wipeId: SECOND_WIPE_ID,
        profileId: PROFILE,
        partition: PARTITION,
      }),
      "session_not_persistent",
    );
    await expectStorageError(
      lifecycle.executeLive(
        pendingFor(layout, "live_clear_pending", { wipeId: WIPE_ID, ...firstPaths }),
      ),
      "path_changed",
    );

    expect(harness.gate.disposition(PROFILE)).toBe("open");
  });

  it("quiesces, revokes, awaits destruction, revalidates, and clears in strict order", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const { lifecycle, pending } = await preparePending(layout, harness);
    harness.calls.length = 0;

    const outcome = await lifecycle.executeLive(pending);

    expect(outcome).toEqual({ status: "restart_delete_pending" });
    expect(harness.calls).toEqual([
      "quiesce:personal",
      "revoke:personal:profile_wipe",
      "physicalDestruction",
      `sessionForPartition:${PARTITION}`,
      "isPersistent",
      "getStoragePath",
      "currentRoots",
      "flushStorageData",
      "closeAllConnections",
      "clearData",
      "clearAuthCache",
      "clearCache",
    ]);
    expect(harness.gate.disposition("personal")).toBe("quiescing");
    expect(harness.sessionCounts).toEqual({ personal: 0, work: 3 });
    expect(harness.capabilityCounts).toEqual({ personal: 0, work: 4 });
    expect(await lstat(layout.storagePath)).toMatchObject({});
  });

  it.each([
    ["timeout", "quiescence_timeout"],
    ["failed", "quiescence_failed"],
  ] as const)("keeps admission blocked and never clears after %s destruction", async (code, expected) => {
    const layout = await createLayout();
    const harness = makeHarness(layout, {
      ok: false,
      code,
      message: "bounded teardown failure",
    });
    const { lifecycle, pending } = await preparePending(layout, harness);
    harness.calls.length = 0;

    const error = await expectStorageError(lifecycle.executeLive(pending), expected);

    expect(error.retryable).toBe(true);
    expect(harness.gate.disposition("personal")).toBe("quiescing");
    expect(harness.calls).toEqual([
      "quiesce:personal",
      "revoke:personal:profile_wipe",
      "physicalDestruction",
    ]);
    expect(harness.calls).not.toContain("clearData");
  });

  it.each([
    ["flushStorageData", "flush"],
    ["closeAllConnections", "connections"],
    ["clearData", "browser_data"],
    ["clearAuthCache", "auth_cache"],
    ["clearCache", "http_cache"],
  ] as const)("identifies the failed %s barrier and keeps admission blocked", async (method, stage) => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    harness.session.failAt = method;
    const { lifecycle, pending } = await preparePending(layout, harness);
    harness.calls.length = 0;

    const error = await expectStorageError(
      lifecycle.executeLive(pending),
      "storage_clear_failed",
    );

    expect(error.stage).toBe(stage);
    expect(error.retryable).toBe(true);
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    expect(harness.calls).toContain(method);
    const barriers = [
      "flushStorageData",
      "closeAllConnections",
      "clearData",
      "clearAuthCache",
      "clearCache",
    ];
    expect(harness.calls.filter((call) => barriers.includes(call))).toEqual(
      barriers.slice(0, barriers.indexOf(method) + 1),
    );
  });

  it.each([
    ["flushStorageData", "flush"],
    ["closeAllConnections", "connections"],
    ["clearData", "browser_data"],
    ["clearAuthCache", "auth_cache"],
    ["clearCache", "http_cache"],
  ] as const)("bounds a never-settling %s barrier and keeps admission blocked", async (method, stage) => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    harness.session.pendingAt = method;
    harness.session.pendingOperation = new Promise<void>(() => undefined);
    const lifecycle = lifecycleFor(harness, {
      liveClearStepTimeoutMs: 10,
      liveClearAggregateTimeoutMs: 100,
    });
    const { pending } = await preparePending(layout, harness, lifecycle);
    harness.calls.length = 0;

    const error = await expectStorageError(
      lifecycle.executeLive(pending),
      "storage_clear_timeout",
    );

    expect(error.stage).toBe(stage);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("browser profile storage clear timed out");
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    const barriers = [
      "flushStorageData",
      "closeAllConnections",
      "clearData",
      "clearAuthCache",
      "clearCache",
    ];
    expect(harness.calls.filter((call) => barriers.includes(call))).toEqual(
      barriers.slice(0, barriers.indexOf(method) + 1),
    );
  });

  it("observes a late storage rejection after timeout without leaking its reason", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    let rejectLate: ((reason: Error) => void) | undefined;
    harness.session.pendingAt = "clearData";
    harness.session.pendingOperation = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
    const lifecycle = lifecycleFor(harness, {
      liveClearStepTimeoutMs: 10,
      liveClearAggregateTimeoutMs: 100,
    });
    const { pending } = await preparePending(layout, harness, lifecycle);

    const error = await expectStorageError(
      lifecycle.executeLive(pending),
      "storage_clear_timeout",
    );
    rejectLate?.(new Error("private credential cache path"));
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));

    expect(error).toMatchObject({
      stage: "browser_data",
      retryable: true,
      message: "browser profile storage clear timed out",
    });
    expect(error.message).not.toContain("credential");
    expect(error.message).not.toContain(layout.root);
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("refuses cold recovery until a timed-out Electron clear promise really settles", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    let resolveLate!: () => void;
    const exactClear = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    harness.session.pendingAt = "clearData";
    harness.session.pendingOperation = exactClear;
    const lifecycle = lifecycleFor(harness, {
      liveClearStepTimeoutMs: 10,
      liveClearAggregateTimeoutMs: 100,
    });
    const { pending } = await preparePending(layout, harness, lifecycle);

    await expectStorageError(lifecycle.executeLive(pending), "storage_clear_timeout");
    const blocked = await expectStorageError(
      lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending")),
      "gate_blocked",
    );

    expect(blocked).toMatchObject({ stage: "cold_validate", retryable: true });
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");

    resolveLate();
    await exactClear;
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));
    await lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending"));

    expect(harness.gate.disposition(PROFILE)).toBe("deleted");
  });

  it("keeps shutdown unclean until a timed-out exact clear promise settles", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    let resolveLate!: () => void;
    const exactClear = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    harness.session.pendingAt = "clearData";
    harness.session.pendingOperation = exactClear;
    const lifecycle = lifecycleFor(harness, {
      liveClearStepTimeoutMs: 5,
      liveClearAggregateTimeoutMs: 25,
    });
    const { pending } = await preparePending(layout, harness, lifecycle);
    await expectStorageError(lifecycle.executeLive(pending), "storage_clear_timeout");

    expect(lifecycle.beginShutdown()).toMatchObject({
      epoch: 1,
      activeOperations: [],
      activeRawClearOperations: ["browser_data"],
    });
    const firstDrain = lifecycle.drainOnQuit();
    expect(lifecycle.drainOnQuit()).toBe(firstDrain);
    const timedOut = await firstDrain;

    expect(timedOut).toMatchObject({
      epoch: 1,
      clean: false,
      operations: ["clear:browser_data"],
      settled: 0,
      timedOut: true,
      activeOperations: [],
      activeRawClearOperations: ["browser_data"],
    });

    resolveLate();
    await exactClear;
    await Promise.resolve();
    const converged = await lifecycle.drainOnQuit();

    expect(converged).toMatchObject({
      epoch: 1,
      clean: true,
      timedOut: false,
      activeOperations: [],
      activeRawClearOperations: [],
    });
    await expectStorageError(
      lifecycle.prepare({ wipeId: SECOND_WIPE_ID, profileId: PROFILE, partition: PARTITION }),
      "gate_blocked",
    );
  });

  it("observes a late clear rejection through shutdown without an unhandled rejection", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    let rejectLate!: (reason: Error) => void;
    harness.session.pendingAt = "clearData";
    harness.session.pendingOperation = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
    const lifecycle = lifecycleFor(harness, {
      liveClearStepTimeoutMs: 5,
      liveClearAggregateTimeoutMs: 100,
    });
    const { pending } = await preparePending(layout, harness, lifecycle);
    await expectStorageError(lifecycle.executeLive(pending), "storage_clear_timeout");

    const drain = lifecycle.drainOnQuit();
    rejectLate(new Error("private cache rejection"));
    const receipt = await drain;
    await Promise.resolve();

    expect(receipt).toMatchObject({
      clean: true,
      operations: ["clear:browser_data"],
      settled: 1,
      fulfilled: 0,
      rejected: 1,
      timedOut: false,
      activeOperations: [],
      activeRawClearOperations: [],
    });
  });

  it("releases the profile registry mutation chain after a live clear timeout", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    harness.session.pendingAt = "clearData";
    harness.session.pendingOperation = new Promise<void>(() => undefined);
    const lifecycle = lifecycleFor(harness, {
      liveClearStepTimeoutMs: 10,
      liveClearAggregateTimeoutMs: 100,
    });
    const registryRoot = join(layout.root, "registry");
    stateRuntime = ManagedRuntime.make(
      makeStateEngineLive(join(layout.root, "vellum-command.db")),
    );
    const state = await stateRuntime.runPromise(StateEngine);
    const registry = makeBrowserProfileService(state, registryRoot, {
      wipeLifecycle: lifecycle,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    await Effect.runPromise(registry.initialize);

    const wipe = Effect.runPromise(Effect.result(registry.wipeProfile(PROFILE)));
    const siblingTouch = Effect.runPromise(registry.touchProfile("work"));
    let siblingDeadline: ReturnType<typeof setTimeout> | undefined;
    const siblingProgress = Promise.race([
      siblingTouch,
      new Promise<never>((_resolve, reject) => {
        siblingDeadline = setTimeout(
          () => reject(new Error("sibling mutation remained blocked")),
          500,
        );
      }),
    ]).finally(() => {
      if (siblingDeadline !== undefined) clearTimeout(siblingDeadline);
    });
    const [wipeResult] = await Promise.all([wipe, siblingProgress]);

    expect(Result.isFailure(wipeResult)).toBe(true);
    if (Result.isFailure(wipeResult)) {
      expect(wipeResult.failure).toMatchObject({
        code: "pending_wipe",
        message: "browser profile wipe incomplete; recovery required",
      });
    }
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    expect(
      await Effect.runPromise(
        state.read("test.browser-pending", (reader) =>
          reader.get(`
            SELECT
              profile_id AS profileId,
              stage
            FROM browser_profile_pending_wipe
            WHERE singleton = 1
          `)
        ),
      ),
    ).toMatchObject({
      profileId: PROFILE,
      stage: "live_clear_pending",
    });
    expect(await Effect.runPromise(registry.partitionName("work"))).toBe(
      "persist:vellum-profile-work",
    );
  });

  it("rejects a changed live Session identity before any storage clear", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const { lifecycle, pending } = await preparePending(layout, harness);
    const replacement = makeSession(layout, harness.calls);
    harness.setSession(replacement);
    harness.calls.length = 0;

    await expectStorageError(lifecycle.executeLive(pending), "path_changed");

    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    expect(harness.calls).not.toContain("clearData");
  });

  it("rejects a changed exact Session storage path before any clear", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const { lifecycle, pending } = await preparePending(layout, harness);
    const otherStorage = join(layout.sessionDataPath, "Partitions", "other-storage");
    await mkdir(otherStorage, { mode: 0o700 });
    harness.session.storagePath = otherStorage;
    harness.calls.length = 0;

    await expectStorageError(lifecycle.executeLive(pending), "path_changed");

    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    expect(harness.calls).not.toContain("flushStorageData");
  });

  it("rejects changed live app roots before any clear", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const { lifecycle, pending } = await preparePending(layout, harness);
    const changedUserData = join(layout.root, "Changed Live User Data");
    const changedSessionData = join(changedUserData, "Session Data");
    await mkdir(changedSessionData, { recursive: true, mode: 0o700 });
    harness.setRoots({
      userDataPath: changedUserData,
      sessionDataPath: changedSessionData,
    });
    harness.calls.length = 0;

    await expectStorageError(lifecycle.executeLive(pending), "root_changed");

    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    expect(harness.calls).not.toContain("flushStorageData");
  });

  it("rejects a storage inode swap between prepare and live clear", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const { lifecycle, pending } = await preparePending(layout, harness);
    await rmdir(layout.storagePath);
    await mkdir(layout.storagePath, { mode: 0o700 });
    harness.calls.length = 0;

    await expectStorageError(lifecycle.executeLive(pending), "path_changed");

    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    expect(harness.calls).not.toContain("flushStorageData");
  });

  it("cold-recovers an absent target idempotently without constructing a Session", async () => {
    const layout = await createLayout();
    await rmdir(layout.storagePath);
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness);
    const pending = pendingFor(layout, "restart_delete_pending");

    await lifecycle.recoverCold(pending);
    await lifecycle.recoverCold(pending);

    expect(harness.sessionPartitionCalls()).toBe(0);
    expect(harness.gate.disposition(PROFILE)).toBe("deleted");
  });

  it("cold-recovers when both the unused target and its parent are absent", async () => {
    const layout = await createLayout();
    await rm(dirname(layout.storagePath), { recursive: true });
    const harness = makeHarness(layout);

    await lifecycleFor(harness).recoverCold(
      pendingFor(layout, "restart_delete_pending"),
    );

    expect(harness.sessionPartitionCalls()).toBe(0);
    expect(harness.gate.disposition(PROFILE)).toBe("deleted");
  });

  it("resumes after a crash immediately following verified quarantine rename", async () => {
    const layout = await createLayout();
    await writeFile(join(layout.storagePath, "cookie"), "secret", { mode: 0o600 });
    const firstHarness = makeHarness(layout);
    const interrupted = lifecycleFor(firstHarness, {
      failpoints: {
        afterQuarantineRename: () => {
          throw new Error("simulated crash");
        },
      },
    });
    const pending = pendingFor(layout, "restart_delete_pending");
    const quarantine = browserProfileQuarantinePath(layout.storagePath, WIPE_ID);
    expect(quarantine).toBeDefined();
    if (quarantine === undefined) throw new Error("missing quarantine path");

    const interruptedError = await expectStorageError(
      interrupted.recoverCold(pending),
      "failpoint",
    );
    expect(interruptedError.retryable).toBe(true);
    await expect(access(layout.storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(quarantine, "cookie"), "utf8")).toBe("secret");
    expect(firstHarness.gate.disposition(PROFILE)).toBe("quiescing");

    const restartHarness = makeHarness(layout);
    const recovered = lifecycleFor(restartHarness);
    await recovered.recoverCold(pending);

    await expect(access(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(layout.storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(restartHarness.sessionPartitionCalls()).toBe(0);
    expect(restartHarness.gate.disposition(PROFILE)).toBe("deleted");
  });

  it("rejects an existing quarantine on a different filesystem identity", async () => {
    const layout = await createLayout();
    const quarantine = browserProfileQuarantinePath(layout.storagePath, WIPE_ID);
    if (quarantine === undefined) throw new Error("missing quarantine path");
    await rename(layout.storagePath, quarantine);
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness, {
      fileSystem: {
        lstat: async (path) => {
          const info = await lstat(path);
          if (path === quarantine) info.dev += 1;
          return info;
        },
      },
    });

    const error = await expectStorageError(
      lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending")),
      "unsafe_path",
    );

    expect(error.stage).toBe("cold_validate");
    expect(await lstat(quarantine)).toMatchObject({});
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("bounds a raw post-open lstat failure without deleting the quarantine", async () => {
    const layout = await createLayout();
    const quarantine = browserProfileQuarantinePath(layout.storagePath, WIPE_ID);
    if (quarantine === undefined) throw new Error("missing quarantine path");
    const harness = makeHarness(layout);
    let quarantineOpened = false;
    const lifecycle = lifecycleFor(harness, {
      fileSystem: {
        opendir: async (path) => {
          const directory = await opendir(path);
          if (path === quarantine) quarantineOpened = true;
          return directory;
        },
        lstat: async (path) => {
          if (path === quarantine && quarantineOpened) {
            throw new Error(`private post-open failure at ${path}`);
          }
          return lstat(path);
        },
      },
    });

    const error = await expectStorageError(
      lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending")),
      "filesystem_failed",
    );

    expect(error.stage).toBe("delete");
    expect(String(error)).not.toContain(layout.root);
    expect(String(error)).not.toContain("private post-open failure");
    expect(await lstat(quarantine)).toMatchObject({});
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("bounds raw directory-iteration failures without leaking the quarantine path", async () => {
    const layout = await createLayout();
    const quarantine = browserProfileQuarantinePath(layout.storagePath, WIPE_ID);
    if (quarantine === undefined) throw new Error("missing quarantine path");
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness, {
      fileSystem: {
        opendir: async (path): Promise<BrowserProfileStorageDirectory> => {
          if (path !== quarantine) return opendir(path);
          return {
            close: async () => undefined,
            async *[Symbol.asyncIterator]() {
              throw new Error(`private iteration failure at ${path}`);
            },
          };
        },
      },
    });

    const error = await expectStorageError(
      lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending")),
      "filesystem_failed",
    );

    expect(error.stage).toBe("delete");
    expect(String(error)).not.toContain(layout.root);
    expect(String(error)).not.toContain("private iteration failure");
    expect(await lstat(quarantine)).toMatchObject({});
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("fsyncs the validated parent after rename and after final quarantine removal", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const durability: string[] = [];
    const quarantine = browserProfileQuarantinePath(layout.storagePath, WIPE_ID);
    if (quarantine === undefined) throw new Error("missing quarantine path");
    const lifecycle = lifecycleFor(harness, {
      fileSystem: {
        rename: async (from, to) => {
          durability.push("rename");
          await rename(from, to);
        },
        rmdir: async (path) => {
          if (path === quarantine) durability.push("rmdir");
          await rmdir(path);
        },
        syncDirectory: async (path) => {
          expect(path).toBe(dirname(layout.storagePath));
          durability.push("sync");
        },
      },
    });

    await lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending"));

    expect(durability).toEqual(["rename", "sync", "rmdir", "sync"]);
    expect(harness.gate.disposition(PROFILE)).toBe("deleted");
  });

  it("retains the gate and quarantine when the post-rename fsync fails", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const quarantine = browserProfileQuarantinePath(layout.storagePath, WIPE_ID);
    if (quarantine === undefined) throw new Error("missing quarantine path");
    const lifecycle = lifecycleFor(harness, {
      fileSystem: {
        syncDirectory: async () => {
          throw new Error("simulated fsync failure");
        },
      },
    });

    const error = await expectStorageError(
      lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending")),
      "filesystem_failed",
    );

    expect(error.stage).toBe("quarantine");
    await expect(access(layout.storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lstat(quarantine)).toMatchObject({});
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("retries the final absence fsync before committing a retained gate", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    let syncCalls = 0;
    const lifecycle = lifecycleFor(harness, {
      fileSystem: {
        syncDirectory: async () => {
          syncCalls += 1;
          if (syncCalls === 2) throw new Error("simulated final fsync failure");
        },
      },
    });
    const pending = pendingFor(layout, "restart_delete_pending");

    const first = await expectStorageError(lifecycle.recoverCold(pending), "filesystem_failed");
    expect(first.stage).toBe("delete");
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
    await expect(access(layout.storagePath)).rejects.toMatchObject({ code: "ENOENT" });

    await lifecycle.recoverCold(pending);

    expect(syncCalls).toBe(3);
    expect(harness.gate.disposition(PROFILE)).toBe("deleted");
  });

  it("unlinks nested symlinks without traversing them and preserves the external canary", async () => {
    const layout = await createLayout();
    const external = join(layout.root, "external-canary");
    await mkdir(external, { mode: 0o700 });
    await writeFile(join(external, "keep"), "preserve", { mode: 0o600 });
    const nested = join(layout.storagePath, "Cache", "nested");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await symlink(external, join(nested, "outside"));
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness);

    await lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending"));

    expect(await readFile(join(external, "keep"), "utf8")).toBe("preserve");
    await expect(access(layout.storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.gate.disposition(PROFILE)).toBe("deleted");
  });

  it("rejects a target outside the recorded roots", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness);
    const outside = join(layout.root, "outside-target");
    await mkdir(outside, { mode: 0o700 });

    const error = await expectStorageError(
      lifecycle.recoverCold(
        pendingFor(layout, "restart_delete_pending", { storagePath: outside }),
      ),
      "unsafe_path",
    );

    expect(error.message).not.toContain(outside);
    expect(harness.gate.disposition(PROFILE)).toBe("open");
  });

  it.each(["userDataPath", "sessionDataPath"] as const)(
    "rejects using the %s root itself as the storage target",
    async (rootKey) => {
      const layout = await createLayout();
      const harness = makeHarness(layout);

      await expectStorageError(
        lifecycleFor(harness).recoverCold(
          pendingFor(layout, "restart_delete_pending", {
            storagePath: layout[rootKey],
          }),
        ),
        "unsafe_path",
      );

      expect(await lstat(layout[rootKey])).toMatchObject({});
      expect(harness.gate.disposition(PROFILE)).toBe("open");
    },
  );

  it("rejects sibling-prefix containment tricks", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness);
    const sibling = `${layout.sessionDataPath}-evil`;
    const target = join(sibling, "personal");
    await mkdir(target, { recursive: true, mode: 0o700 });

    await expectStorageError(
      lifecycle.recoverCold(
        pendingFor(layout, "restart_delete_pending", { storagePath: target }),
      ),
      "unsafe_path",
    );

    expect(await lstat(target)).toMatchObject({});
  });

  it("rejects a top-level regular-file target", async () => {
    const layout = await createLayout();
    await rmdir(layout.storagePath);
    await writeFile(layout.storagePath, "do-not-delete", { mode: 0o600 });
    const harness = makeHarness(layout);

    await expectStorageError(
      lifecycleFor(harness).recoverCold(pendingFor(layout, "restart_delete_pending")),
      "unsafe_path",
    );

    expect(await readFile(layout.storagePath, "utf8")).toBe("do-not-delete");
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("rejects a symlink at the target", async () => {
    const layout = await createLayout();
    const external = join(layout.root, "external-target");
    await mkdir(external, { mode: 0o700 });
    await writeFile(join(external, "keep"), "preserve", { mode: 0o600 });
    await rmdir(layout.storagePath);
    await symlink(external, layout.storagePath);
    const harness = makeHarness(layout);

    await expectStorageError(
      lifecycleFor(harness).recoverCold(pendingFor(layout, "restart_delete_pending")),
      "unsafe_path",
    );

    expect(await readFile(join(external, "keep"), "utf8")).toBe("preserve");
  });

  it("rejects a symlink in the ancestor chain", async () => {
    const layout = await createLayout();
    const partitions = dirname(layout.storagePath);
    const external = join(layout.root, "external-partitions");
    await rename(partitions, external);
    await symlink(external, partitions);
    const harness = makeHarness(layout);

    await expectStorageError(
      lifecycleFor(harness).recoverCold(pendingFor(layout, "restart_delete_pending")),
      "unsafe_path",
    );

    expect(await lstat(join(external, "exact-electron-storage"))).toMatchObject({});
  });

  it("rejects a symlinked recorded root without touching its real target", async () => {
    const layout = await createLayout();
    const actualUserData = join(layout.root, "Actual User Data");
    await rename(layout.userDataPath, actualUserData);
    await symlink(actualUserData, layout.userDataPath);
    const canary = join(actualUserData, "Session Data", "root-canary");
    await writeFile(canary, "preserve", { mode: 0o600 });
    const harness = makeHarness(layout);

    await expectStorageError(
      lifecycleFor(harness).recoverCold(pendingFor(layout, "restart_delete_pending")),
      "unsafe_path",
    );

    expect(await readFile(canary, "utf8")).toBe("preserve");
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("rejects a regular file in the ancestor chain", async () => {
    const layout = await createLayout();
    const partitions = dirname(layout.storagePath);
    await rm(partitions, { recursive: true });
    await writeFile(partitions, "do-not-traverse", { mode: 0o600 });
    const harness = makeHarness(layout);

    await expectStorageError(
      lifecycleFor(harness).recoverCold(pendingFor(layout, "restart_delete_pending")),
      "unsafe_path",
    );

    expect(await readFile(partitions, "utf8")).toBe("do-not-traverse");
  });

  it("rejects changed current roots and leaves admission blocked", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const changedUserData = join(layout.root, "Changed User Data");
    const changedSessionData = join(changedUserData, "Session Data");
    await mkdir(changedSessionData, { recursive: true, mode: 0o700 });
    const changedPlatform: BrowserProfileStoragePlatform = {
      currentRoots: () => ({
        userDataPath: changedUserData,
        sessionDataPath: changedSessionData,
      }),
      sessionForPartition: () => {
        throw new Error("cold recovery must not construct a Session");
      },
    };

    const error = await expectStorageError(
      lifecycleFor(harness, { platform: changedPlatform }).recoverCold(
        pendingFor(layout, "restart_delete_pending"),
      ),
      "root_changed",
    );

    expect(error.retryable).toBe(false);
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("fails closed when target and deterministic quarantine both exist", async () => {
    const layout = await createLayout();
    const quarantine = browserProfileQuarantinePath(layout.storagePath, WIPE_ID);
    if (quarantine === undefined) throw new Error("missing quarantine path");
    await mkdir(quarantine, { mode: 0o700 });
    const harness = makeHarness(layout);

    const error = await expectStorageError(
      lifecycleFor(harness).recoverCold(pendingFor(layout, "restart_delete_pending")),
      "collision",
    );

    expect(error.retryable).toBe(false);
    expect(await lstat(layout.storagePath)).toMatchObject({});
    expect(await lstat(quarantine)).toMatchObject({});
    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("detects an inode substitution performed by the rename seam", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    const lifecycle = lifecycleFor(harness, {
      fileSystem: {
        rename: async (from, to) => {
          await rename(from, to);
          await rmdir(to);
          await mkdir(to, { mode: 0o700 });
        },
      },
    });

    await expectStorageError(
      lifecycle.recoverCold(pendingFor(layout, "restart_delete_pending")),
      "path_changed",
    );

    expect(harness.gate.disposition(PROFILE)).toBe("quiescing");
  });

  it("keeps failures fixed and free of path, secret, and underlying exception text", async () => {
    const layout = await createLayout();
    const harness = makeHarness(layout);
    harness.session.failAt = "getStoragePath";
    const lifecycle = lifecycleFor(harness);

    const error = await expectStorageError(
      lifecycle.prepare({ wipeId: WIPE_ID, profileId: PROFILE, partition: PARTITION }),
      "session_unavailable",
    );
    const rendered = `${String(error)} ${JSON.stringify(error)}`;

    expect(rendered).not.toContain(layout.root);
    expect(rendered).not.toContain("private storage path");
    expect(rendered).not.toContain("secret");
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThan(128);
  });
});
