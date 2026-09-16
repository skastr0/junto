import { readFileSync } from "node:fs";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { HOST_RUNTIME_REMEDY_STAGE } from "../src/shared/deploy-job";
import type { HostOpsActivate, HostOpsAttach, HostOpsConfigure, HostOpsCopy } from "../src/shared/host-ops";
import { InstallationId } from "../src/shared/station-api";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  applyHostRuntime,
  deployResultFromHostOpsCopy,
} from "../src/main/junto/hosts/host-runtime";
import { HostOps } from "../src/main/junto/hosts/host-ops";

const installationId = Schema.decodeUnknownSync(InstallationId);
const observedAt = "2026-08-13T21:00:00.000Z";

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["terminal"],
};

const readyCopy = (extra: Partial<HostOpsCopy> = {}): HostOpsCopy => ({
  ok: true,
  exit: 0,
  stdout: "STATION_READY pid=12 term=1 browser=1\n",
  stderr: "",
  localApp: "/Applications/Junto.app",
  expectedPackage: "present",
  after: {
    package: "present",
    deployLock: "absent",
    incoming: "absent",
    termSocket: "present",
  },
  elapsedMs: 1,
  observedAt,
  ...extra,
});

const linuxCopy = (): HostOpsCopy => ({
  ok: true,
  exit: 0,
  stdout: "LINUX_USERLAND_DEPLOY_V1 ok=1 state=ready release=1.2.3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
  stderr: "",
  expectedPackage: "present",
  after: {
    package: "present",
    deployLock: "absent",
    incoming: "absent",
    termSocket: "unknown",
  },
  elapsedMs: 1,
  observedAt,
});

const configured: HostOpsConfigure = {
  ok: true,
  detail: "configured through Station API",
  stationInstallationId: installationId("station-installation"),
  configuredAt: "2026-07-27T12:00:02.000Z",
  observedAt,
};

const darwinActivate: HostOpsActivate = {
  ok: true,
  detail: "Junto is running on this Mac",
  stages: [],
  disposition: "ready",
  observedAt,
};

const linuxActivate: HostOpsActivate = {
  ok: true,
  detail: "systemd user service restarted",
  stages: [],
  disposition: "ready",
  observedAt,
};

const attachUp: HostOpsAttach = {
  ok: true,
  workAttach: "up",
  detail: "work attach connected",
  observedAt,
};

const attachDown: HostOpsAttach = {
  ok: false,
  workAttach: "down",
  detail: "work attach down",
  observedAt,
};

const fakeOps = (impl: {
  readonly copy?: () => Effect.Effect<HostOpsCopy>;
  readonly cleanup?: () => Effect.Effect<{
    readonly ok: boolean;
    readonly removed: readonly string[];
    readonly stderr: string;
    readonly observedAt: string;
  }>;
  readonly configure?: () => Effect.Effect<HostOpsConfigure>;
  readonly activate?: () => Effect.Effect<HostOpsActivate>;
  readonly attach?: () => Effect.Effect<HostOpsAttach>;
}): Layer.Layer<HostOps> =>
  Layer.succeed(
    HostOps,
    HostOps.of({
      inspect: () =>
        Effect.succeed({
          endpoint: "studio-box",
          platform: "darwin",
          network: "up",
          package: "present",
          deployLock: "absent",
          incoming: "absent",
          termSocket: "present",
          process: "up",
          workAttach: "unknown",
          observedAt,
        }),
      copy: impl.copy ?? (() => Effect.succeed(readyCopy())),
      cleanup:
        impl.cleanup ??
        (() =>
          Effect.succeed({
            ok: true,
            removed: [],
            stderr: "",
            observedAt,
          })),
      configure: impl.configure ?? (() => Effect.succeed(configured)),
      activate: impl.activate ?? (() => Effect.succeed(darwinActivate)),
      attach: impl.attach ?? (() => Effect.succeed(attachUp)),
    }),
  );

const runApply = (
  gap: "needInstall" | "needConfigure" | "needRestart",
  layer: Layer.Layer<HostOps>,
  prior?: string,
) =>
  Effect.runPromise(
    applyHostRuntime({
      host,
      gap,
      ...(prior === undefined
        ? {}
        : { priorInstallationId: installationId(prior) }),
    }).pipe(Effect.provide(layer)),
  );

const expectRemedyStages = (
  stages: readonly string[] | undefined,
  extras: readonly string[] = [],
) => {
  expect(stages).toContain(HOST_RUNTIME_REMEDY_STAGE.copy);
  expect(stages).toContain(HOST_RUNTIME_REMEDY_STAGE.restart);
  expect(stages).toContain(HOST_RUNTIME_REMEDY_STAGE.wait);
  for (const extra of extras) {
    expect(stages).toContain(extra);
  }
};

describe("HostRuntime apply over HostOps", () => {
  it("is one apply loop over HostOps, not Darwin or Linux ceremony", () => {
    const runtime = readFileSync(
      new URL("../src/main/junto/hosts/host-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(runtime).toContain("applyHostRuntime");
    expect(runtime).toContain("HostOps.layerForTarget");
    expect(runtime).toContain("HostConfigure.layer");
    expect(runtime).toContain("ops.cleanup");
    expect(runtime).toContain("ops.copy");
    expect(runtime).toContain("expectedPackageStateFromGap");
    expect(runtime).toContain("ops.configure");
    expect(runtime).toContain("ops.activate");
    expect(runtime).toContain("ops.attach");
    expect(runtime).not.toContain("applyDarwinHostRuntime");
    expect(runtime).not.toContain("applyLinuxHostRuntime");
    expect(runtime).not.toContain("DarwinApplyOperations");
    expect(runtime).not.toContain("LinuxApplyOperations");
    expect(runtime).not.toContain("adapterFor");
    expect(runtime).not.toContain("--vellum-headless");
    expect(runtime).not.toContain('from "./deploy-darwin"');
    expect(() =>
      readFileSync(
        new URL("../src/main/junto/hosts/host-runtime-darwin.ts", import.meta.url),
      ),
    ).toThrow();
    expect(() =>
      readFileSync(
        new URL("../src/main/junto/hosts/host-runtime-linux.ts", import.meta.url),
      ),
    ).toThrow();
  });

  it("configures and activates on first install", async () => {
    const configure = vi.fn(() => Effect.succeed(configured));
    const activate = vi.fn(() => Effect.succeed(darwinActivate));
    const result = await runApply(
      "needInstall",
      fakeOps({
        copy: () =>
          Effect.succeed(
            readyCopy({
              stdout: "ENROLLMENT_READY pid=12 station=1\n",
            }),
          ),
        configure,
        activate,
      }),
    );
    expect(configure).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.role).toBe("remote");
    expect(result.detail).toContain("Junto is running on this Mac");
    expectRemedyStages(result.stages, [HOST_RUNTIME_REMEDY_STAGE.sign]);
  });

  it("activates after first-install configure even when copy claims ready", async () => {
    const activate = vi.fn(() => Effect.succeed(darwinActivate));
    const result = await runApply(
      "needConfigure",
      fakeOps({ activate }),
    );
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expectRemedyStages(result.stages, [HOST_RUNTIME_REMEDY_STAGE.sign]);
  });

  it("copies an enrolled Remote as present even when the package is gone", async () => {
    const copy = vi.fn(() => Effect.succeed(readyCopy()));
    await runApply("needRestart", fakeOps({ copy }), "station-installation");
    expect(copy).toHaveBeenCalledWith("present");
  });

  it("copies first install as absent so the enroll door can bind", async () => {
    const copy = vi.fn(() =>
      Effect.succeed(
        readyCopy({
          stdout: "ENROLLMENT_READY pid=12 station=1\n",
        }),
      ),
    );
    await runApply("needInstall", fakeOps({ copy }));
    expect(copy).toHaveBeenCalledWith("absent");
  });

  it("skips configure on needRestart and still activates", async () => {
    const configure = vi.fn(() => Effect.succeed(configured));
    const activate = vi.fn(() =>
      Effect.succeed({
        ...darwinActivate,
        detail: "supervised Remote runtime ready",
      }),
    );
    const result = await runApply(
      "needRestart",
      fakeOps({ configure, activate }),
      "station-installation",
    );
    expect(configure).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.configuration.detail).toContain("configure skipped");
    expect(result.stationInstallationId).toBe("station-installation");
    expectRemedyStages(result.stages, [HOST_RUNTIME_REMEDY_STAGE.sign]);
  });

  it("keeps a failed Station configure as a Station receipt", async () => {
    const result = await runApply(
      "needInstall",
      fakeOps({
        copy: () =>
          Effect.succeed(
            readyCopy({
              stdout: "ENROLLMENT_READY pid=12 station=1\n",
            }),
          ),
        configure: () =>
          Effect.succeed({
            ok: false,
            detail: "Station API pair refused",
            code: "conflict",
            observedAt,
          }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(result.detail).toContain("Station API");
    expect(result.detail).not.toMatch(/SSH failed/u);
    expect(result.configuration.detail).toBe("Station API pair refused");
  });

  it("retries copy and restart until attach connects", async () => {
    const configure = vi.fn(() => Effect.succeed(configured));
    const activate = vi.fn(() => Effect.succeed(darwinActivate));
    let attaches = 0;
    const result = await runApply(
      "needRestart",
      fakeOps({
        configure,
        activate,
        attach: () => {
          attaches += 1;
          return Effect.succeed(attaches >= 2 ? attachUp : attachDown);
        },
      }),
      "station-installation",
    );
    expect(configure).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(attaches).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.copyAgain);
    expectRemedyStages(result.stages, [HOST_RUNTIME_REMEDY_STAGE.sign]);
  });

  it("stops on a hand-opened app instead of retrying", async () => {
    const activate = vi.fn(() => Effect.succeed(darwinActivate));
    const result = await runApply(
      "needRestart",
      fakeOps({
        copy: () =>
          Effect.succeed(
            readyCopy({
              ok: false,
              exit: 1,
              stdout: "",
              stderr: "UNSUPERVISED_INCUMBENT_REQUIRES_LAUNCHAGENT exe_pids=333,",
            }),
          ),
        activate,
        attach: () => Effect.succeed(attachDown),
      }),
      "station-installation",
    );
    expect(activate).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      "Quit the Junto window you opened by hand, then Deploy again.",
    );
    expect(result.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.copy);
    expect(result.stages).not.toContain(HOST_RUNTIME_REMEDY_STAGE.restart);
  });

  it("configures first install from a Linux HostOps layer without signing", async () => {
    const configure = vi.fn(() => Effect.succeed(configured));
    const activate = vi.fn(() => Effect.succeed(linuxActivate));
    const result = await runApply(
      "needConfigure",
      fakeOps({
        copy: () => Effect.succeed(linuxCopy()),
        configure,
        activate,
      }),
    );
    expect(configure).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("configured");
    expect(result.detail).toContain("systemd user service restarted");
    expectRemedyStages(result.stages);
    expect(result.stages).not.toContain(HOST_RUNTIME_REMEDY_STAGE.sign);
  });

  it("does not configure on needRestart", async () => {
    const configure = vi.fn(() => Effect.succeed(configured));
    const result = await runApply(
      "needRestart",
      fakeOps({
        copy: () => Effect.succeed(linuxCopy()),
        configure,
        activate: () => Effect.succeed(linuxActivate),
      }),
      "station-box",
    );
    expect(configure).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.configuration.detail).toContain("configure skipped");
    expectRemedyStages(result.stages);
  });

  it("does not treat package ready as attach when work attach does not connect", async () => {
    const result = await runApply(
      "needRestart",
      fakeOps({
        copy: () => Effect.succeed(linuxCopy()),
        activate: () => Effect.succeed(linuxActivate),
        attach: () => Effect.succeed(attachDown),
      }),
      "station-box",
    );
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("indeterminate");
    expect(result.detail).toContain("work attach did not connect");
    expect(result.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.copyAgain);
    expectRemedyStages(result.stages);
  });

  it("retries copy until attach connects, without pairing again", async () => {
    const configure = vi.fn(() => Effect.succeed(configured));
    let deploys = 0;
    let attaches = 0;
    const result = await runApply(
      "needConfigure",
      fakeOps({
        copy: () => {
          deploys += 1;
          return Effect.succeed(linuxCopy());
        },
        configure,
        activate: () => Effect.succeed(linuxActivate),
        attach: () => {
          attaches += 1;
          return Effect.succeed(attaches >= 2 ? attachUp : attachDown);
        },
      }),
    );
    expect(deploys).toBe(2);
    expect(configure).toHaveBeenCalledOnce();
    expect(attaches).toBe(2);
    expect(result.ok).toBe(true);
    expectRemedyStages(result.stages);
  });

  it("stops on a missing login session instead of retrying", async () => {
    const configure = vi.fn(() => Effect.succeed(configured));
    const activate = vi.fn(() => Effect.succeed(linuxActivate));
    const result = await runApply(
      "needInstall",
      fakeOps({
        copy: () =>
          Effect.succeed({
            ...linuxCopy(),
            ok: false,
            stdout: "",
            stderr: "owner-local systemd user service is unavailable",
          }),
        configure,
        activate,
        attach: () => Effect.succeed(attachDown),
      }),
    );
    expect(configure).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      "This machine has no login session, so Junto cannot start.",
    );
    expect(result.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.copy);
    expect(result.stages).not.toContain(HOST_RUNTIME_REMEDY_STAGE.restart);
  });

  it("retries activate and does not treat package ready as attach", async () => {
    const activate = vi.fn(() =>
      Effect.succeed({
        ok: false,
        detail: "systemd user service restart failed",
        stages: [],
        disposition: "indeterminate" as const,
        observedAt,
      }),
    );
    const attach = vi.fn(() => Effect.succeed(attachUp));
    const result = await runApply(
      "needRestart",
      fakeOps({
        copy: () => Effect.succeed(linuxCopy()),
        activate,
        attach,
      }),
      "station-box",
    );
    expect(activate).toHaveBeenCalledTimes(3);
    expect(attach).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("supervised runtime activate failed");
  });
});

const copyReceipt = (
  input: Partial<HostOpsCopy> &
    Pick<HostOpsCopy, "ok" | "stdout" | "stderr">,
): HostOpsCopy => ({
  exit: input.exit ?? (input.ok ? 0 : 1),
  expectedPackage: "present",
  after: {
    package: "present",
    deployLock: "absent",
    incoming: "absent",
    termSocket: "present",
  },
  elapsedMs: 1,
  observedAt,
  ...input,
});

describe("HostOps copy maps onto the apply package result", () => {
  it("treats STATION_READY as a ready package so activate and attach still run", () => {
    const result = deployResultFromHostOpsCopy(host, copyReceipt({
      ok: true,
      stdout: "STATION_READY pid=12 term=1 browser=1\n",
      stderr: "",
    }));
    expect(result.ok).toBe(true);
    expect(result.disposition).toBe("ready");
    expect(result.detail).toContain("Studio (studio-box)");
    expect(result.detail).toContain("running on this Mac");
  });

  it("treats ENROLLMENT_READY as configuration-required for first install", () => {
    const result = deployResultFromHostOpsCopy(host, copyReceipt({
      ok: true,
      stdout: "ENROLLMENT_READY pid=12 station=1\n",
      stderr: "",
    }));
    expect(result.ok).toBe(true);
    expect(result.disposition).toBe("configuration-required");
  });

  it("keeps leftover incoming as not-started so apply can retry after cleanup", () => {
    const result = deployResultFromHostOpsCopy(host, copyReceipt({
      ok: false,
      exit: 12,
      stdout: "",
      stderr: "UNBOUND_DEPLOY_PATH_PRESENT",
      tag: "UNBOUND_DEPLOY_PATH_PRESENT",
    }));
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("not-started");
    expect(result.message).toBe("UNBOUND_DEPLOY_PATH_PRESENT");
  });
});
