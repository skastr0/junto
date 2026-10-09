import { installCoreRunner } from "./core-runner";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ObservabilityLoggerLive } from "./junto/observability";
import { resolveJuntoHome } from "@shared/junto-home";
import { makeMachineCoreLayer } from "./core-runtime";
import { runningBuildIdentity } from "./junto/build-identity";
import { getCompiledMachineReleaseCatalog } from "@shared/machine-release";
import { makeMachineBundleSources } from "./junto/hosts/machine-bundle-download";
import productMetadata from "../../package.json";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { linuxDesktopInstallStorageDoctor } from "./junto/update/linux-install";
import { termControlSocketPath } from "@shared/term-control";
import { CodexLive, CodexService } from "./services/codex";
import { AppInfoLive, AppInfoService } from "./services/app-info";
import { ModelService } from "./junto/model/service";
import { termPlane } from "./junto/term/plane";
import {
  assessNativeTerminalDoctor,
  probeNativeTerminalReadiness,
} from "./junto/term/native-readiness";
import { KernelService } from "./junto/kernel/service";
import { SettingsService } from "./junto/settings/service";
import { SnapshotsService } from "./junto/snapshots";
import { UsageService } from "./junto/usage/usage-service";
import { HostsService } from "./junto/hosts";
import { primeHostsSnapshot } from "./junto/hosts/snapshot";
import {
  deferredUpdateHostHooks,
  installUpdateProviderHandle,
  macArm64UpdateFeed,
  linuxX64UpdateFeed,
  makePlatformUpdateProvider,
  makeUpdateServiceLayer,
} from "./junto/update";

// UpdateService joins this ManagedRuntime — never a second runtime.
// Host quiesce/relaunch hooks are late-bound from main/index after boot.
const UpdateServiceLive = Layer.unwrap(
  Effect.sync(() => {
    const provider = makePlatformUpdateProvider({
      platform: process.platform,
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion() || productMetadata.version,
    });
    installUpdateProviderHandle(provider);
    const packaged = app.isPackaged;
    return makeUpdateServiceLayer({
      currentVersion: app.getVersion() || productMetadata.version,
      provider,
      host: deferredUpdateHostHooks(),
      install: {
        packaged,
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron ?? "unknown",
        providerKind: provider.kind,
        ...(packaged && provider.kind === "mac"
          ? { feedUrl: macArm64UpdateFeed().url }
          : packaged && provider.kind === "linux"
            ? { feedUrl: linuxX64UpdateFeed().url }
            : {}),
      },
    });
  }),
);

let machineControlReady = (): boolean => false;
export const setMachineControlReadiness = (ready: () => boolean): void => {
  machineControlReady = ready;
};

const MachineServicesLive = Layer.unwrap(Effect.sync(() => {
  const home = resolveJuntoHome(), build = runningBuildIdentity();
  const catalog = getCompiledMachineReleaseCatalog();
  return makeMachineCoreLayer({
    home, build, ready: () => machineControlReady(),
    ...makeMachineBundleSources({ home, build, catalog, localRoot: () => process.env.JUNTO_MACHINE_BUNDLES ??
      (app.isPackaged ? join(process.resourcesPath, "machines") : join(app.getAppPath(), "dist", "machines")),
    }),
  });
}));

export const RootLayer = MachineServicesLive;

// The product owns one warm runtime and disposes it on shutdown.
const AppLayer = Layer.mergeAll(RootLayer, AppInfoLive, CodexLive, UpdateServiceLive, ObservabilityLoggerLive);
export const AppRuntime = ManagedRuntime.make(AppLayer);
installCoreRunner(AppRuntime);

export const buildDoctorReport = Effect.gen(function* () {
  // Ensure registry snapshot is current before host-aware doctor / transports.
  yield* Effect.tryPromise({
    try: () => primeHostsSnapshot(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

  const appInfo = yield* AppInfoService;
  const codex = yield* CodexService;
  const model = yield* ModelService;
  const snapshots = yield* SnapshotsService;
  const kernel = yield* KernelService;
  const usage = yield* UsageService;
  const settings = yield* SettingsService;
  const hosts = yield* HostsService;

  const station = yield* appInfo.stationInfo;
  const hostsDoctorSnapshot = yield* hosts.doctorSnapshot;

  const serviceResults = yield* Effect.all(
    [
      codex.doctor,
      model.listCanvases().pipe(Effect.match({
        onFailure: () => ({ id: "canvases", label: "Canvases", status: "error" as const, detail: "Canvas storage is unavailable" }),
        onSuccess: (names) => ({ id: "canvases", label: "Canvases", status: "ok" as const, detail: `${names.length} canvases` }),
      })),
      snapshots.doctor,
      kernel.doctor,
      usage.doctor,
      settings.doctor,
      Effect.succeed(hostsDoctorSnapshot.check),
    ],
    { concurrency: "unbounded" },
  );

  const running = termPlane.router.runningCount();
  const sockOk = existsSync(termControlSocketPath());
  const nativeTerminalProbe = yield* Effect.promise(() =>
    probeNativeTerminalReadiness()
  );
  const terminalCheck = assessNativeTerminalDoctor({
    probe: nativeTerminalProbe,
    controlReady: sockOk,
    running,
  });
  const linuxInstallStorage = process.platform === "linux"
    ? yield* Effect.promise(() => linuxDesktopInstallStorageDoctor({ executablePath: process.execPath }))
    : undefined;
  const services: ReadonlyArray<ServiceCheck> = [
    ...serviceResults,
    terminalCheck,
    ...(linuxInstallStorage === undefined ? [] : [linuxInstallStorage]),
  ];
  const recommendations = services
    .filter((service) => service.status !== "ok")
    .map((service) => `${service.label}: ${service.detail}`);

  return {
    checkedAt: new Date().toISOString(),
    station,
    services,
    recommendations,
  } satisfies DoctorReport;
});
