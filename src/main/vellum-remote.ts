/**
 * Node-only Linux Remote entry — no Electron, no Xvfb, no window host,
 * no browser host.
 *
 * Modes:
 *   --vellum-state-preflight   sealed candidate readiness (JSON receipt)
 *   --install-user-service     write systemd user unit + station helper
 *   (default)                  boot RemoteRuntime product planes
 */
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import productMetadata from "../../package.json";
import {
  isRemotePackaged,
  remoteAppVersion,
  RemoteRuntime,
} from "./remote-runtime";
import { STATE_UPDATE_PREFLIGHT_SWITCH } from "./vellum/state/candidate-readiness";
import { inspectStateUpdateCandidate } from "./vellum/state/candidate-readiness";
import { withStateUpdateCandidate } from "./vellum/state/update-candidate";
import { evaluateSchemaCompatibility } from "./vellum/state/schema-version-probe";
import { CURRENT_STATE_SCHEMA_VERSION } from "./vellum/state/migrations";
import { resolveControlHome } from "./vellum/control-home";
import { configurePeerPidHelperRoots } from "./vellum/process-identity";
import { resolvedSpawnEnv } from "./vellum/adapters/exec";
import {
  INSTALL_USER_SERVICE_SWITCH,
  installUserlandLinuxRemoteService,
  resolveReleaseDirectoryFromRemoteBinary,
} from "./vellum/supervision/install-user-service";
import {
  startWorkControlServer,
  publishSystemdGenerationReadiness,
  type WorkControlServer,
} from "./vellum/work/control";
import {
  startStationControlServer,
  type StationControlServer,
} from "./vellum/station/control-server";
import {
  startStationRemoteReportPump,
  type StationRemoteReportPump,
} from "./vellum/station/remote-report-pump";
import { makeOwnerLocalStationControlHandoffAuthority } from "./vellum/station/peer-authority";
import { StationApiService } from "./vellum/station/api";
import { StationRepository } from "./vellum/station/repository";
import { WorkRepository } from "./vellum/work/repository";
import { KernelService } from "./vellum/kernel/service";
import { HerdrPlane } from "./vellum/herdr/plane";
import { HermesPlane } from "./vellum/hermes/plane";
import { termPlane } from "./vellum/term/plane";
import { compiledLicenseBuildConfig } from "./vellum/license/compiled-config";
import {
  makeLicenseCoordinator,
  type LicenseCoordinator,
} from "./vellum/license/coordinator";
import { LicenseService } from "./vellum/license/service";
import { remoteLeaseState } from "./vellum/license/remote-lease-state";

const argvHas = (flag: string): boolean => process.argv.includes(flag);

const failExit = (code: number, message: string): never => {
  console.error(message);
  process.exit(code);
};

const resolveBinaryPath = (): string => {
  const raw = process.argv[1] ?? process.execPath;
  try {
    return realpathSync(resolve(raw));
  } catch {
    return resolve(raw);
  }
};

// ---------------------------------------------------------------------------
// --vellum-state-preflight
// ---------------------------------------------------------------------------

const runStatePreflight = async (): Promise<void> => {
  if (!isRemotePackaged(resolveBinaryPath())) {
    failExit(
      1,
      "[state-preflight] packaged candidate execution is required (release tree or VELLUM_PACKAGED=1)",
    );
  }
  try {
    const receipt = await Effect.runPromise(
      withStateUpdateCandidate(inspectStateUpdateCandidate),
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`, () => {
      process.exit(0);
    });
  } catch (error) {
    console.error("[state-preflight] candidate readiness failed:", error);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// --install-user-service
// ---------------------------------------------------------------------------

const runInstallUserService = (): void => {
  try {
    const result = installUserlandLinuxRemoteService(resolveBinaryPath());
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        releaseDirectory: result.releaseDirectory,
        unitPath: result.unitPath,
        helperPath: result.helperPath,
      })}\n`,
    );
    process.exit(0);
  } catch (error) {
    failExit(
      1,
      `[install-user-service] ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

// ---------------------------------------------------------------------------
// Default boot
// ---------------------------------------------------------------------------

type Handles = {
  workControl?: WorkControlServer;
  stationControl?: StationControlServer;
  stationRemoteReportPump?: StationRemoteReportPump;
  licenseCoordinator?: LicenseCoordinator;
  herdr?: {
    readonly start: Effect.Effect<void, unknown, never>;
    readonly beginShutdown: (reason?: string) => void;
  };
  hermes?: {
    readonly shutdown: { readonly drainOnQuit: () => Promise<unknown> };
  };
  kernel?: {
    readonly start: () => void;
    readonly suspend: () => void;
  };
  shuttingDown: boolean;
};

const openExternalNoop = async (_url: string): Promise<void> => {
  // Remote-support never opens a customer portal.
};

const runProductBoot = async (): Promise<void> => {
  // DISPLAY / WAYLAND_DISPLAY / XAUTHORITY are intentionally ignored.
  void process.env.DISPLAY;
  void process.env.WAYLAND_DISPLAY;
  void process.env.XAUTHORITY;

  const handles: Handles = { shuttingDown: false };

  const beginShutdown = (reason: string): void => {
    if (handles.shuttingDown) return;
    handles.shuttingDown = true;
    handles.licenseCoordinator?.stopMonitoring();
    handles.kernel?.suspend();
    handles.workControl?.beginShutdown();
    void handles.stationRemoteReportPump?.close();
    handles.stationControl?.beginShutdown();
    termPlane.beginShutdown(reason);
    handles.herdr?.beginShutdown();
    void handles.hermes?.shutdown.drainOnQuit();
  };

  const drainAndExit = async (code: number, reason: string): Promise<void> => {
    beginShutdown(reason);
    try {
      await termPlane.drainOnQuit(reason);
    } catch {
      // Best-effort drain; process exit reclaims FDs.
    }
    try {
      await RemoteRuntime.dispose();
    } catch {
      // Engine release best-effort.
    }
    process.exit(code);
  };

  process.once("SIGTERM", () => {
    void drainAndExit(0, "SIGTERM");
  });
  process.once("SIGINT", () => {
    void drainAndExit(0, "SIGINT");
  });

  await resolvedSpawnEnv();

  const compatibility = evaluateSchemaCompatibility();
  if (!compatibility.ok) {
    failExit(
      1,
      `[schema] installed state schema ${compatibility.userVersion} is newer than supported ${compatibility.supportedVersion}`,
    );
  }

  {
    const roots: string[] = [];
    if (
      typeof process.resourcesPath === "string" &&
      process.resourcesPath.length > 0
    ) {
      roots.push(join(process.resourcesPath, "bin"));
    }
    try {
      const releaseRoot = resolveReleaseDirectoryFromRemoteBinary(
        resolveBinaryPath(),
      );
      roots.push(join(releaseRoot, "resources/bin"));
    } catch {
      // unpackaged / non-release tree
    }
    if (!isRemotePackaged(resolveBinaryPath())) {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        roots.push(resolve(here, "../../scripts"));
      } catch {
        // ignore
      }
    }
    configurePeerPidHelperRoots(roots);
  }

  const controlHome = resolveControlHome({
    envHome: process.env.HOME,
    electronHome: process.env.HOME ?? process.cwd(),
    userData: process.env.VELLUM_HOME ?? process.env.HOME ?? process.cwd(),
    e2e: process.env.VELLUM_E2E === "1",
    headless: true,
    packaged: isRemotePackaged(resolveBinaryPath()),
    explicitHome: process.env.VELLUM_HOME,
  });

  const stations = await RemoteRuntime.runPromise(StationRepository);
  const stationConfiguration = await RemoteRuntime.runPromise(
    stations.configuration,
  );

  // Packaged unconfigured Remote: enrollment-only station control, then hold.
  if (
    isRemotePackaged(resolveBinaryPath()) &&
    stationConfiguration === undefined
  ) {
    try {
      handles.stationControl = await startStationControlServer({
        home: controlHome,
        appVersion: remoteAppVersion(),
        stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        run: (effect) => RemoteRuntime.runPromise(effect),
        localHandoffAuthority: makeOwnerLocalStationControlHandoffAuthority(),
        readiness: () => ({
          database: true,
          workControl: false,
          simulation: false,
        }),
        admitRequest: (request) =>
          request.op === "status" ||
          request.op === "pair" ||
          request.op === "configure",
      });
      console.error(
        "[station-control] enrollment bootstrap listening; restart after configure",
      );
      return;
    } catch (error) {
      console.error("[station-control] enrollment bootstrap failed:", error);
      await drainAndExit(1, "station-bootstrap-startup-failure");
      return;
    }
  }

  if (stationConfiguration?.configuration.role === "remote") {
    try {
      const facts = await RemoteRuntime.runPromise(stations.statusFacts);
      const candidates: number[] = [];
      if (facts.pairing?.pairedAt) {
        const ms = Date.parse(facts.pairing.pairedAt);
        if (Number.isFinite(ms)) candidates.push(ms);
      }
      const headReceived = facts.projection?.receivedAt;
      if (typeof headReceived === "string") {
        const ms = Date.parse(headReceived);
        if (Number.isFinite(ms)) candidates.push(ms);
      }
      if (candidates.length > 0) {
        remoteLeaseState.hydrate(Math.max(...candidates));
      }
    } catch {
      // Missing pairing/projection is a never-checked-in Remote.
    }
  }

  const packaged = isRemotePackaged(resolveBinaryPath());
  const licenseConfig = compiledLicenseBuildConfig(packaged);
  const licenseService = await RemoteRuntime.runPromise(LicenseService);
  const coordinator = makeLicenseCoordinator({
    config: licenseConfig,
    mode:
      stationConfiguration?.configuration.role === "remote"
        ? "remote-support"
        : "licensed-command-center",
    service: licenseService,
    run: (effect) => RemoteRuntime.runPromise(effect),
    openExternal: openExternalNoop,
    application: {
      relaunch: () => {
        process.exit(0);
      },
      quit: () => {
        process.exit(0);
      },
    },
    remoteLastCheckInAtMs: () => remoteLeaseState.read(),
  });
  handles.licenseCoordinator = coordinator;
  // No renderer IPC on Node remote — skip registerIpc.
  const licenseDecision = await coordinator.decideStartupAdmission();
  if (!licenseDecision.admitted) {
    console.error(
      `[license] remote startup denied (${licenseDecision.status.reason})`,
    );
    await drainAndExit(1, "license-startup-denied");
    return;
  }

  try {
    handles.workControl = await startWorkControlServer({
      version: remoteAppVersion() || productMetadata.version,
      run: (effect) => RemoteRuntime.runPromise(effect),
    });
  } catch (error) {
    console.error("[work-control] failed to start:", error);
    await drainAndExit(1, "work-control-startup-failure");
    return;
  }

  const [herdr, hermes] = await Promise.all([
    RemoteRuntime.runPromise(HerdrPlane),
    RemoteRuntime.runPromise(HermesPlane),
  ]);
  handles.herdr = herdr;
  handles.hermes = hermes;
  await RemoteRuntime.runPromise(herdr.start);

  try {
    handles.kernel = await RemoteRuntime.runPromise(KernelService);
    handles.kernel.start();
    handles.stationControl = await startStationControlServer({
      home: controlHome,
      appVersion: remoteAppVersion(),
      stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      run: (effect) => RemoteRuntime.runPromise(effect),
      localHandoffAuthority: makeOwnerLocalStationControlHandoffAuthority(),
      readiness: () => ({
        database: true,
        workControl: true,
        simulation: true,
      }),
    });
    const [stationApi, work] = await Promise.all([
      RemoteRuntime.runPromise(StationApiService),
      RemoteRuntime.runPromise(WorkRepository),
    ]);
    handles.stationRemoteReportPump = startStationRemoteReportPump({
      api: stationApi,
      stations,
      work,
      control: handles.stationControl,
    });
  } catch (error) {
    console.error("[station-control] failed to start:", error);
    await drainAndExit(1, "station-control-startup-failure");
    return;
  }

  try {
    await termPlane.start({ controlHome });
  } catch (error) {
    console.error("[term] control socket failed to start:", error);
  }

  try {
    await coordinator.startMonitoring();
  } catch {
    console.error("[license] monitoring failed to start");
  }

  try {
    publishSystemdGenerationReadiness();
  } catch (error) {
    console.error("[readiness] systemd generation publish failed:", error);
    await drainAndExit(1, "systemd-readiness-failure");
    return;
  }

  console.error(
    `[vellum-remote] running v${remoteAppVersion()} role=${
      stationConfiguration?.configuration.role ?? "unconfigured"
    }`,
  );
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  if (argvHas(STATE_UPDATE_PREFLIGHT_SWITCH)) {
    await runStatePreflight();
    return;
  }
  if (argvHas(INSTALL_USER_SERVICE_SWITCH)) {
    runInstallUserService();
    return;
  }
  await runProductBoot();
};

void main().catch((error) => {
  console.error("[vellum-remote] fatal:", error);
  process.exit(1);
});
