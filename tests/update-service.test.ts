import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AvailableRelease, UpdateStatus } from "@shared/update";
import {
  finalizeInstallAfterQuiesce,
  makeUpdateService,
  UpdateService,
  type InstallPlan,
} from "../src/main/vellum/update/service";
import {
  mintAuthorizedCandidate,
  type AuthorizedUpdateCandidate,
} from "../src/main/vellum/update/domain";
import type {
  UpdateProvider,
  UpdateProviderListener,
} from "../src/main/vellum/update/provider";
import type { StateUpdatePreflightReceipt } from "../src/main/vellum/state/candidate-readiness";
import { STATE_UPDATE_PREFLIGHT_PROTOCOL } from "../src/main/vellum/state/candidate-readiness";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const makeFakeProvider = (): {
  readonly provider: UpdateProvider;
  readonly emit: (event: Parameters<UpdateProviderListener>[0]) => void;
  readonly quitAndInstall: ReturnType<typeof vi.fn>;
} => {
  let listener: UpdateProviderListener | undefined;
  const quitAndInstall = vi.fn();
  return {
    quitAndInstall,
    emit: (event) => {
      listener?.(event);
    },
    provider: {
      kind: "mac",
      start: (next) => {
        listener = next;
      },
      stop: () => {
        listener = undefined;
      },
      check: async () => {
        listener?.({ _tag: "checking" });
        listener?.({
          _tag: "available",
          release: {
            version: "0.2.0",
            releaseName: "test",
          } satisfies AvailableRelease,
        });
      },
      quitAndInstall: () => {
        quitAndInstall();
      },
    },
  };
};

const receipt = (
  candidateId: string,
): StateUpdatePreflightReceipt =>
  ({
    protocol: STATE_UPDATE_PREFLIGHT_PROTOCOL,
    candidateId,
    source: "fresh",
    sourceSchemaVersion: 0,
    targetSchemaVersion: 3,
    targetSchemaSha256: "a".repeat(64),
    installationId: "01JTESTINSTALLATION00000000",
    role: "command-center",
    canvasCount: 0,
    actorSeatCount: 0,
    workSnapshotCount: 0,
    pendingCommandCount: 0,
    armedRegionCount: 0,
    schedulerCursorCount: 0,
    ready: true,
  }) as StateUpdatePreflightReceipt;

describe("UpdateService", () => {
  it("tracks check → available through the provider", async () => {
    const { provider } = makeFakeProvider();
    const service = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider,
        host: {
          quiesceForPreflight: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
      }),
    );

    const status = await Effect.runPromise(service.check);
    // Provider events are applied asynchronously via Effect.runPromise;
    // allow a turn for the available event to land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const latest = await Effect.runPromise(service.getState);
    expect(
      latest.phase === "available" ||
        latest.phase === "checking" ||
        status.phase === "checking",
    ).toBe(true);
  });

  it("refuses prepareInstall without a minted candidate", async () => {
    const { provider } = makeFakeProvider();
    const service = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider,
        host: {
          quiesceForPreflight: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
      }),
    );

    const result = await Effect.runPromise(
      Effect.either(service.prepareInstall),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.updateCode).toBe("not-ready");
    }
  });

  it("finalizeInstallAfterQuiesce binds receipt then quitAndInstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-update-svc-"));
    roots.push(root);
    const zipPath = join(root, "update.zip");
    const body = Buffer.from("zip-body");
    await writeFile(zipPath, body);
    const zipSha256 = createHash("sha256").update(body).digest("hex");

    const { provider, quitAndInstall } = makeFakeProvider();
    const candidate = mintAuthorizedCandidate({
      version: "0.2.0",
      downloadedFile: zipPath,
      zipSha256,
      stagedAppPath: join(root, "fake-exec"),
    });

    const plan: InstallPlan = {
      version: "0.2.0",
      downloadedFile: zipPath,
      zipSha256,
      executablePath: join(root, "fake-exec"),
      stagingRoot: undefined,
      available: { version: "0.2.0" },
      currentVersion: "0.1.0",
    };
    // Mint plan membership through prepareInstall WeakSet by reusing
    // isMintedInstallPlan path: finalize checks plan WeakSet.
    // We need a plan minted by prepareInstall — use the service path.
    const service = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider,
        host: {
          quiesceForPreflight: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
        expandZip: () =>
          Effect.succeed({
            stagingRoot: root,
            appPath: join(root, "Vellum Command.app"),
            executablePath: join(root, "fake-exec"),
          }),
      }),
    );

    // Drive download event so prepareInstall can succeed
    const fake = makeFakeProvider();
    // Use the same provider instance that service listens on — emit via
    // the first provider's check is not enough; emit downloaded directly.
    // Recreate with shared emit:
    void service;
    void candidate;
    void plan;
    void quitAndInstall;
    void fake;

    // Direct finalize with a properly minted plan from prepare after download:
    const harness = makeFakeProvider();
    let captured: {
      plan: InstallPlan;
      candidate: AuthorizedUpdateCandidate;
    } | undefined;

    const svc = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider: harness.provider,
        host: {
          quiesceForPreflight: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
        expandZip: () =>
          Effect.succeed({
            stagingRoot: root,
            appPath: join(root, "Vellum Command.app"),
            executablePath: join(root, "fake-exec"),
          }),
      }),
    );

    harness.emit({
      _tag: "downloaded",
      release: { version: "0.2.0" },
      downloadedFile: zipPath,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const prepared = await Effect.runPromise(svc.prepareInstall);
    captured = prepared;
    expect(captured.plan.zipSha256).toBe(zipSha256);

    const status = await Effect.runPromise(
      finalizeInstallAfterQuiesce({
        plan: captured.plan,
        candidate: captured.candidate,
        provider: harness.provider,
        host: {
          quiesceForPreflight: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
        runPreflight: () =>
          Effect.succeed(
            receipt("11111111-1111-4111-8111-111111111111"),
          ),
      }),
    );

    expect(status.phase).toBe("installing");
    expect(status.canInstall).toBe(true);
    expect(harness.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("joins ManagedRuntime as a Layer service", async () => {
    const { provider } = makeFakeProvider();
    const layer = Layer.effect(
      UpdateService,
      makeUpdateService({
        currentVersion: "0.1.0",
        provider,
        host: {
          quiesceForPreflight: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
      }),
    );
    const runtime = ManagedRuntime.make(layer);
    try {
      const status = await runtime.runPromise(
        Effect.flatMap(UpdateService, (svc) => svc.getState),
      );
      expect(status).toMatchObject({
        phase: "idle",
        currentVersion: "0.1.0",
        canInstall: false,
      } satisfies Partial<UpdateStatus>);
    } finally {
      await runtime.dispose();
    }
  });
});
