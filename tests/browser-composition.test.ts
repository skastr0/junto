import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { formatNodeRef } from "../src/shared/node-ref";
import {
  makeBrowserAutomationProduct,
  type BrowserAutomationProduct,
} from "../src/main/vellum/browser/agent-product";
import { BrowserCapabilityIssueDenied } from "../src/main/vellum/browser/capabilities";
import {
  BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE,
  BrowserCompositionStartupError,
  startBrowserComposition,
  type BrowserComposition,
  type BrowserCompositionDependencies,
} from "../src/main/vellum/browser/composition";
import {
  makeBrowserProfileStorageLifecycle,
  type BrowserProfileStorageDependencies,
  type BrowserProfileStoragePlatform,
} from "../src/main/vellum/browser/profile-storage";
import {
  makeBrowserProfileService,
  type BrowserProfilePendingWipe,
  type BrowserProfileWipeLifecycle,
} from "../src/main/vellum/browser/profiles";
import type { BrowserViewAdapter } from "../src/main/vellum/browser/sessions";

const PAGE_REF = formatNodeRef({ canvasName: "work", nodeId: "page-1" });
const FIXED_TIME = "2026-07-17T12:00:00.000Z";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const productDependencies = (root: string): BrowserCompositionDependencies =>
  ({
    chat: {
      chatRestartWithLocalBrowserAuthority: async () => ({
        ok: true,
        sessionId: "chat-session",
      }),
      chatRevokeLocalBrowserAuthority: async () => ({ ok: true }),
    },
    herdr: {
      killPane: async () => ({ ok: true, data: { closed: true } }),
    },
    readCanvas: async () => ({ nodes: [], edges: [] }),
    resolvePageTarget: async () => ({
      ok: false,
      code: "not_found",
      message: "missing",
    }),
    getHerdrPaneMeta: async () => ({ ok: false, code: "not_found" }),
    confirm: async () => false,
    controlHome: join(root, "control"),
  }) as BrowserCompositionDependencies;

const wipePaths = (root: string, profileId: string) => ({
  userDataPath: join(root, "electron-user-data"),
  sessionDataPath: join(root, "electron-user-data", "Session Data"),
  storagePath: join(
    root,
    "electron-user-data",
    "Session Data",
    "Partitions",
    profileId,
  ),
});

const seedPendingWipe = async (profileRoot: string): Promise<void> => {
  const lifecycle: BrowserProfileWipeLifecycle = {
    prepare: async ({ profileId }) => wipePaths(profileRoot, profileId),
    executeLive: async () => ({ status: "restart_delete_pending" }),
    recoverCold: async () => undefined,
  };
  const profiles = makeBrowserProfileService(profileRoot, {
    wipeLifecycle: lifecycle,
    now: () => new Date(FIXED_TIME),
  });
  await run(profiles.initialize);
  await expect(run(profiles.wipeProfile("personal"))).resolves.toEqual({
    status: "restart_required",
  });
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("browser production composition", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
    root = "";
    vi.restoreAllMocks();
  });

  const freshRuntime = async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-browser-composition-"));
    const profileRoot = join(root, "profiles");
    let viewCreations = 0;
    const viewAdapter: BrowserViewAdapter = () => {
      viewCreations += 1;
      throw new Error("browser view constructed before admission");
    };
    const sessionForPartition = vi.fn((_partition: string) => {
      throw new Error("Electron Session constructed before admission");
    });
    const storagePlatform: BrowserProfileStoragePlatform = {
      currentRoots: () => ({
        userDataPath: join(root, "electron-user-data"),
        sessionDataPath: join(root, "electron-user-data", "Session Data"),
      }),
      sessionForPartition,
    };
    return {
      profileRoot,
      viewAdapter,
      storagePlatform,
      sessionForPartition,
      viewCreations: () => viewCreations,
    };
  };

  it("shares one gate across storage, sessions, and automation without constructing Electron authority", async () => {
    const runtime = await freshRuntime();
    let captured: BrowserProfileStorageDependencies | undefined;
    const composition = await startBrowserComposition(
      productDependencies(root),
      () => undefined,
      {
        profileRoot: runtime.profileRoot,
        viewAdapter: runtime.viewAdapter,
        storagePlatform: runtime.storagePlatform,
        makeStorageLifecycle: (dependencies) => {
          captured = dependencies;
          return makeBrowserProfileStorageLifecycle(dependencies);
        },
      },
    );

    try {
      if (captured === undefined) throw new Error("storage dependencies not captured");
      expect(captured.profileGate).toBe(composition.profileGate);
      expect(runtime.sessionForPartition).not.toHaveBeenCalled();
      expect(runtime.viewCreations()).toBe(0);

      const sessionDelegate = vi.spyOn(composition.sessions, "beginProfileQuiescence");
      captured.sessions.beginProfileQuiescence("INVALID");
      expect(sessionDelegate).toHaveBeenCalledOnce();
      const capabilityDelegate = vi.spyOn(composition.automation.registry, "revokeByProfile");
      captured.capabilities.revokeByProfile("personal", "profile_wipe");
      expect(capabilityDelegate).toHaveBeenCalledOnce();

      expect(composition.profileGate.begin("personal")).toMatchObject({ ok: true });
      await expect(
        composition.sessions.open({
          ref: PAGE_REF,
          nodeId: "page-1",
          url: "https://example.com/",
          profile: "personal",
        }),
      ).resolves.toMatchObject({ ok: false, code: "forbidden" });
      expect(runtime.viewCreations()).toBe(0);

      const principal = composition.automation.registry.createPrincipal();
      expect(() =>
        composition.automation.registry.issue(principal, {
          actions: ["open"],
          targets: [{
            ref: PAGE_REF,
            profile: "personal",
            exactOrigins: ["https://example.com"],
          }],
          ttlMs: 60_000,
          maxUses: 1,
          maxInFlight: 1,
        }),
      ).toThrow(BrowserCapabilityIssueDenied);
    } finally {
      composition.automation.close();
    }
  });

  it("does not cross the activation boundary until pending wipe recovery completes", async () => {
    const runtime = await freshRuntime();
    await seedPendingWipe(runtime.profileRoot);
    const releaseRecovery = deferred();
    const events: string[] = [];
    const recoverCold = vi.fn(async (_pending: BrowserProfilePendingWipe) => {
      events.push("recover:start");
      await releaseRecovery.promise;
      events.push("recover:end");
    });
    const activate = vi.fn((_composition: BrowserComposition) => {
      events.push("activate");
    });

    const starting = startBrowserComposition(
      productDependencies(root),
      activate,
      {
        profileRoot: runtime.profileRoot,
        viewAdapter: runtime.viewAdapter,
        storagePlatform: runtime.storagePlatform,
        makeStorageLifecycle: () => ({
          prepare: async ({ profileId }) => wipePaths(runtime.profileRoot, profileId),
          executeLive: async () => ({ status: "complete" }),
          recoverCold,
        }),
      },
    );
    await vi.waitFor(() => expect(recoverCold).toHaveBeenCalledOnce());
    expect(events).toEqual(["recover:start"]);
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.sessionForPartition).not.toHaveBeenCalled();
    expect(runtime.viewCreations()).toBe(0);

    releaseRecovery.resolve();
    const composition = await starting;
    try {
      expect(events).toEqual(["recover:start", "recover:end", "activate"]);
      expect(activate).toHaveBeenCalledOnce();
      expect(runtime.sessionForPartition).not.toHaveBeenCalled();
      expect(runtime.viewCreations()).toBe(0);
    } finally {
      composition.automation.close();
    }
  });

  it("closes partial automation and emits only the fixed failure when recovery fails", async () => {
    const runtime = await freshRuntime();
    await seedPendingWipe(runtime.profileRoot);
    let closeCount = 0;
    const activate = vi.fn();
    const makeAutomation = (
      dependencies: Parameters<typeof makeBrowserAutomationProduct>[0],
    ): BrowserAutomationProduct => {
      const product = makeBrowserAutomationProduct(dependencies);
      return Object.freeze({
        ...product,
        close: () => {
          closeCount += 1;
          return product.close();
        },
      });
    };

    const failure = await startBrowserComposition(
      productDependencies(root),
      activate,
      {
        profileRoot: runtime.profileRoot,
        viewAdapter: runtime.viewAdapter,
        storagePlatform: runtime.storagePlatform,
        makeStorageLifecycle: () => ({
          prepare: async ({ profileId }) => wipePaths(runtime.profileRoot, profileId),
          executeLive: async () => ({ status: "complete" }),
          recoverCold: async () => {
            throw new Error(`private recovery detail at ${root}`);
          },
        }),
        makeAutomationProduct: makeAutomation,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BrowserCompositionStartupError);
    expect(failure).toMatchObject({
      name: "BrowserCompositionStartupError",
      message: BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE,
    });
    expect((failure as Error).message).not.toContain(root);
    expect(activate).not.toHaveBeenCalled();
    expect(closeCount).toBe(1);
    expect(runtime.sessionForPartition).not.toHaveBeenCalled();
    expect(runtime.viewCreations()).toBe(0);
  });
});
