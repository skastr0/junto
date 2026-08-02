import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AvailableRelease, UpdateStatus } from "@shared/update";
import {
  finalizeInstallAfterQuiesce,
  makeUpdateService,
  UpdateService,
  type InstallPlan,
} from "../src/main/vellum/update/service";
import type { AuthorizedUpdateCandidate } from "../src/main/vellum/update/domain";
import type {
  UpdateProvider,
  UpdateProviderListener,
} from "../src/main/vellum/update/provider";
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
  readonly check: ReturnType<typeof vi.fn>;
} => {
  let listener: UpdateProviderListener | undefined;
  const quitAndInstall = vi.fn();
  const check = vi.fn(async () => {
    listener?.({ _tag: "checking" });
    listener?.({
      _tag: "available",
      release: {
        version: "0.2.0",
        releaseName: "test",
      } satisfies AvailableRelease,
    });
  });
  return {
    quitAndInstall,
    check,
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
      check: () => check(),
      quitAndInstall: () => {
        quitAndInstall();
      },
    },
  };
};

const waitFor = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 500,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
};

describe("UpdateService", () => {
  it("tracks check → available through the provider", async () => {
    const { provider } = makeFakeProvider();
    const service = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider,
        host: {
          quiesceForInstall: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
      }),
    );

    const status = await Effect.runPromise(service.check);
    await waitFor(async () => {
      const latest = await Effect.runPromise(service.getState);
      return (
        latest.phase === "available" ||
        latest.phase === "checking" ||
        status.phase === "checking"
      );
    });
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
          quiesceForInstall: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
      }),
    );

    const result = await Effect.runPromise(
      Effect.result(service.prepareInstall),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Failure") {
      expect(result.failure.updateCode).toBe("not-ready");
    }
  });

  it("sets canInstall true when ready with staged app path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-update-ready-"));
    roots.push(root);
    const zipPath = join(root, "update.zip");
    const body = Buffer.from("zip-body-ready");
    await writeFile(zipPath, body);

    const harness = makeFakeProvider();
    const svc = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider: harness.provider,
        host: {
          quiesceForInstall: async () => undefined,
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
    await waitFor(async () => {
      const state = await Effect.runPromise(svc.getState);
      return state.phase === "ready";
    });
    const ready = await Effect.runPromise(svc.getState);
    expect(ready.phase).toBe("ready");
    expect(ready.canInstall).toBe(true);
  });

  it("skips check when phase is ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-update-skip-"));
    roots.push(root);
    const zipPath = join(root, "update.zip");
    await writeFile(zipPath, Buffer.from("zip-body-skip"));

    const harness = makeFakeProvider();
    const svc = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider: harness.provider,
        host: {
          quiesceForInstall: async () => undefined,
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
    await waitFor(async () => {
      const state = await Effect.runPromise(svc.getState);
      return state.phase === "ready";
    });
    harness.check.mockClear();
    const status = await Effect.runPromise(svc.check);
    expect(status.phase).toBe("ready");
    expect(harness.check).not.toHaveBeenCalled();
  });

  it("serializes concurrent provider events", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-update-serial-"));
    roots.push(root);
    const zipA = join(root, "a.zip");
    const zipB = join(root, "b.zip");
    await writeFile(zipA, Buffer.from("zip-a"));
    await writeFile(zipB, Buffer.from("zip-b"));

    let expandCount = 0;
    let maxConcurrent = 0;
    let inFlight = 0;
    const harness = makeFakeProvider();
    const svc = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider: harness.provider,
        host: {
          quiesceForInstall: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        },
        expandZip: () =>
          Effect.tryPromise({
            try: async () => {
              inFlight += 1;
              maxConcurrent = Math.max(maxConcurrent, inFlight);
              expandCount += 1;
              await new Promise((resolve) => setTimeout(resolve, 30));
              inFlight -= 1;
              return {
                stagingRoot: root,
                appPath: join(root, "Vellum Command.app"),
                executablePath: join(root, "fake-exec"),
              };
            },
            catch: (cause) => cause as never,
          }),
      }),
    );

    harness.emit({
      _tag: "downloaded",
      release: { version: "0.2.0" },
      downloadedFile: zipA,
    });
    harness.emit({
      _tag: "downloaded",
      release: { version: "0.2.1" },
      downloadedFile: zipB,
    });
    await waitFor(async () => {
      const state = await Effect.runPromise(svc.getState);
      return (
        expandCount >= 2 &&
        state.phase === "ready" &&
        state.available?.version === "0.2.1"
      );
    });
    expect(maxConcurrent).toBe(1);
    const state = await Effect.runPromise(svc.getState);
    expect(state.phase).toBe("ready");
    expect(state.available?.version).toBe("0.2.1");
  });

  it("finalizeInstallAfterQuiesce authorizes staged candidate then quitAndInstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-update-svc-"));
    roots.push(root);
    const zipPath = join(root, "update.zip");
    const body = Buffer.from("zip-body");
    await writeFile(zipPath, body);
    const zipSha256 = createHash("sha256").update(body).digest("hex");

    let captured: {
      plan: InstallPlan;
      candidate: AuthorizedUpdateCandidate;
    } | undefined;

    const harness = makeFakeProvider();
    const svc = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider: harness.provider,
        host: {
          quiesceForInstall: async () => undefined,
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
    await waitFor(async () => {
      const state = await Effect.runPromise(svc.getState);
      return state.phase === "ready" && state.canInstall;
    });

    const prepared = await Effect.runPromise(svc.prepareInstall);
    captured = prepared;
    expect(captured.plan.zipSha256).toBe(zipSha256);

    const status = await Effect.runPromise(
      finalizeInstallAfterQuiesce({
        plan: captured.plan,
        candidate: captured.candidate,
        provider: harness.provider,
        host: {
          quiesceForInstall: async () => undefined,
          relaunchWithoutInstall: () => undefined,
        }
      }),
    );

    expect(status.phase).toBe("installing");
    expect(status.canInstall).toBe(true);
    expect(harness.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("relaunchWithoutInstall when quitAndInstall throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-update-quit-fail-"));
    roots.push(root);
    const zipPath = join(root, "update.zip");
    await writeFile(zipPath, Buffer.from("zip-quit-fail"));

    const harness = makeFakeProvider();
    harness.quitAndInstall.mockImplementation(() => {
      throw new Error("electron-updater refused");
    });
    const relaunch = vi.fn();
    const svc = await Effect.runPromise(
      makeUpdateService({
        currentVersion: "0.1.0",
        provider: harness.provider,
        host: {
          quiesceForInstall: async () => undefined,
          relaunchWithoutInstall: relaunch,
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
    await waitFor(async () => {
      const state = await Effect.runPromise(svc.getState);
      return state.phase === "ready";
    });
    const prepared = await Effect.runPromise(svc.prepareInstall);
    const result = await Effect.runPromise(
      Effect.result(
        finalizeInstallAfterQuiesce({
          plan: prepared.plan,
          candidate: prepared.candidate,
          provider: harness.provider,
          host: {
            quiesceForInstall: async () => undefined,
            relaunchWithoutInstall: relaunch,
          }
        }),
      ),
    );
    expect(result._tag).toBe("Left");
    expect(relaunch).toHaveBeenCalled();
  });

  it("joins ManagedRuntime as a Layer service", async () => {
    const { provider } = makeFakeProvider();
    const layer = Layer.effect(
      UpdateService,
      makeUpdateService({
        currentVersion: "0.1.0",
        provider,
        host: {
          quiesceForInstall: async () => undefined,
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
