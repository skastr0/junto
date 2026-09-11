/**
 * Node-only Linux Remote entry — no Electron, no Xvfb, no window host,
 * no browser host.
 *
 * Modes:
 *   --install-user-service     write systemd user unit + station helper
 *   (default)                  boot RemoteRuntime product planes
 */
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  isRemotePackaged,
  remoteAppVersion,
  RemoteRuntime,
} from "./remote-runtime";
import { evaluateSchemaCompatibility } from "./vellum-command/state/schema-version-probe";
import { CURRENT_STATE_SCHEMA_VERSION } from "./vellum-command/state/migrations";
import { resolveControlHome } from "./vellum-command/control-home";
import { configurePeerPidHelperRoots } from "./vellum-command/process-identity";
import { resolvedSpawnEnv } from "./vellum-command/adapters/exec";
import {
  INSTALL_USER_SERVICE_SWITCH,
  installUserlandLinuxRemoteService,
  resolveReleaseDirectoryFromRemoteBinary,
} from "./vellum-command/supervision/install-user-service";
import {
  startWorkControlServer,
  publishSystemdGenerationReadiness,
  type WorkControlServer,
} from "./vellum-command/work/control";
import {
  startStationControlServer,
  type StationControlServer,
} from "./vellum-command/station/control-server";
import {
  startStationRemoteReportPump,
  type StationRemoteReportPump,
} from "./vellum-command/station/remote-report-pump";
import { makeOwnerLocalStationControlHandoffAuthority } from "./vellum-command/station/peer-authority";
import { StationApiService } from "./vellum-command/station/api";
import { StationRepository } from "./vellum-command/station/repository";
import { WorkRepository } from "./vellum-command/work/repository";
import {
  KernelService,
  type KernelHost,
} from "./vellum-command/kernel/service";
import { HermesPlane } from "./vellum-command/hermes/plane";
import { HERMES_INTEGRATION_ENABLED } from "@shared/features";
import { modeFromConfiguration, startupDoor } from "@shared/station-mode";
import { termPlane } from "./vellum-command/term/plane";
import { startTransportJournal } from "./vellum-command/observability";
import { configureTerminalRouterLayeredRunner } from "./vellum-command/term/router";

const argvHas = (flag: string): boolean => process.argv.includes(flag);

const failExit = (code: number, message: string): never => {
  console.error(message);
  process.exit(code);
};

const resolveBinaryPath = (): string => {
  // Wrapper exports VELLUM_COMMAND_REMOTE_BINARY so install sees the
  // generation-pinned shell path after exec replaces argv0 with bundled node.
  const fromEnv = process.env.VELLUM_COMMAND_REMOTE_BINARY?.trim();
  const raw =
    fromEnv && fromEnv.length > 0
      ? fromEnv
      : (process.argv[1] ?? process.execPath);
  try {
    return realpathSync(resolve(raw));
  } catch {
    return resolve(raw);
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
  hermes?: {
    readonly shutdown: { readonly drainOnQuit: () => Promise<unknown> };
  };
  kernel?: {
    readonly start: (host: KernelHost) => void;
    readonly suspend: () => void;
  };
  shuttingDown: boolean;
};

const runProductBoot = async (): Promise<void> => {
  startTransportJournal();
  // DISPLAY / WAYLAND_DISPLAY / XAUTHORITY are intentionally ignored.
  void process.env.DISPLAY;
  void process.env.WAYLAND_DISPLAY;
  void process.env.XAUTHORITY;

  // Bind RemoteRuntime before any term dial can need SshTransport/Scope.
  configureTerminalRouterLayeredRunner((effect) =>
    RemoteRuntime.runPromise(effect as never),
  );

  const handles: Handles = { shuttingDown: false };

  const beginShutdown = (reason: string): void => {
    if (handles.shuttingDown) return;
    handles.shuttingDown = true;
    handles.kernel?.suspend();
    handles.workControl?.beginShutdown();
    void handles.stationRemoteReportPump?.close();
    handles.stationControl?.beginShutdown();
    termPlane.beginShutdown(reason);
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
    userData: process.env.VELLUM_COMMAND_HOME ?? process.env.HOME ?? process.cwd(),
    e2e: process.env.VELLUM_COMMAND_E2E === "1",
    headless: true,
    packaged: isRemotePackaged(resolveBinaryPath()),
    explicitHome: process.env.VELLUM_COMMAND_HOME,
  });

  const stations = await RemoteRuntime.runPromise(StationRepository);
  const stationConfiguration = await RemoteRuntime.runPromise(
    stations.configuration,
  );
  const packaged = isRemotePackaged(resolveBinaryPath());
  // Same rule as the Electron main: the persisted mode picks the door, one
  // selection feeds both bind sites, and the Node remote is always headless.
  const stationMode = modeFromConfiguration(
    stationConfiguration?.configuration.role,
  );
  const stationDoor = startupDoor({
    mode: stationMode,
    packaged,
    headless: true,
  });
  if (stationDoor === undefined) {
    console.error(
      `[station-control] headless ${stationMode} boot binds no enroll door and no peer door`,
    );
  }

  // Packaged Unenrolled ingress: enroll door only, then hold. No report
  // pump or product planes. Never also bind the peer door.
  if (stationDoor === "enroll") {
    try {
      handles.stationControl = await startStationControlServer({
        door: "enroll",
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

  try {
    handles.workControl = await startWorkControlServer({
      version: remoteAppVersion(),
      run: (effect) => RemoteRuntime.runPromise(effect),
    });
  } catch (error) {
    console.error("[work-control] failed to start:", error);
    await drainAndExit(1, "work-control-startup-failure");
    return;
  }

  const hermes = await RemoteRuntime.runPromise(HermesPlane);
  handles.hermes = HERMES_INTEGRATION_ENABLED ? hermes : undefined;

  try {
    const kernel = await RemoteRuntime.runPromise(KernelService);
    handles.kernel = kernel;
    // V4-KERNEL + V4-PROGRAM: host-owned ManagedRuntime entry.
    // Factory program via runFork (Effect control plane).
    kernel.start({
      runPromise: (effect) => RemoteRuntime.runPromise(effect as never),
      runFork: (effect) => {
        RemoteRuntime.runFork(effect as never);
      },
    });
    if (stationDoor === "peer") {
      handles.stationControl = await startStationControlServer({
        door: "peer",
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
        runPromise: (effect) => RemoteRuntime.runPromise(effect as never),
      });
    }
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
    publishSystemdGenerationReadiness();
  } catch (error) {
    console.error("[readiness] systemd generation publish failed:", error);
    await drainAndExit(1, "systemd-readiness-failure");
    return;
  }

  console.error(
    `[vellum-command-remote] running v${remoteAppVersion()} role=${
      stationConfiguration?.configuration.role ?? "unconfigured"
    }`,
  );
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  if (argvHas(INSTALL_USER_SERVICE_SWITCH)) {
    runInstallUserService();
    return;
  }
  await runProductBoot();
};

void main().catch((error) => {
  console.error("[vellum-command-remote] fatal:", error);
  process.exit(1);
});
