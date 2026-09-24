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
import { configureBoardDelivery } from "./junto/work/board-delivery";
import { setManagedPulseDeliver } from "./junto/term/managed-pulse-bridge";
import { injectionSupervisor } from "./junto/term/injection-supervisor";
import {
  clearDeliveredForBinding,
  peekFirstTypedEntry,
  takeFirstTypedEntryIfCurrent,
} from "./junto/term/first-typed";
import { composeFactoryDelivery } from "./junto/term/factory-delivery-composition";
import { isManagedTerminalReady } from "./junto/term/drive/readiness";
import { evaluateSchemaCompatibility } from "./junto/state/schema-version-probe";
import { CURRENT_STATE_SCHEMA_VERSION } from "./junto/state/migrations";
import { resolveControlHome } from "./junto/control-home";
import { configurePeerPidHelperRoots } from "./junto/process-identity";
import { resolvedSpawnEnv } from "./junto/adapters/exec";
import {
  INSTALL_USER_SERVICE_SWITCH,
  installUserlandLinuxRemoteService,
  resolveReleaseDirectoryFromRemoteBinary,
} from "./junto/supervision/install-user-service";
import {
  startWorkControlServer,
  publishSystemdGenerationReadiness,
  type WorkControlServer,
} from "./junto/work/control";
import {
  composeOverseer,
  type OverseerComposition,
} from "./junto/overseer/composition";
import {
  startStationControlServer,
  type StationControlServer,
} from "./junto/station/control-server";
import {
  startStationRemoteReportPump,
  type StationRemoteReportPump,
} from "./junto/station/remote-report-pump";
import { makeOwnerLocalStationControlHandoffAuthority } from "./junto/station/peer-authority";
import { StationApiService } from "./junto/station/api";
import { StationRepository } from "./junto/station/repository";
import { WorkRepository } from "./junto/work/repository";
import {
  KernelService,
  type KernelHost,
} from "./junto/kernel/service";
import { HermesPlane } from "./junto/hermes/plane";
import { HERMES_INTEGRATION_ENABLED } from "@shared/features";
import { modeFromConfiguration, startupDoor } from "@shared/station-mode";
import { termPlane } from "./junto/term/plane";
import { seatStateRuntime } from "./junto/term/agent-state";
import { terminalObserverPlane } from "./junto/term/observer";
import { createManagedTerminalDrive } from "./junto/term/drive/managed-drive-factory";
import { attachManagedTerminalDriveRuntime } from "./junto/term/drive/managed-drive-runtime";
import { bindManagedTerminalDriveForOverseer } from "./junto/term/managed-drive-holder";
import { startTransportJournal } from "./junto/observability";
import { configureTerminalRouterLayeredRunner } from "./junto/term/router";

const argvHas = (flag: string): boolean => process.argv.includes(flag);

const failExit = (code: number, message: string): never => {
  console.error(message);
  process.exit(code);
};

const resolveBinaryPath = (): string => {
  // Wrapper exports JUNTO_REMOTE_BINARY so install sees the
  // generation-pinned shell path after exec replaces argv0 with bundled node.
  const fromEnv = process.env.JUNTO_REMOTE_BINARY?.trim();
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
  overseer?: OverseerComposition;
  stationControl?: StationControlServer;
  drive?: { readonly dispose: () => void; readonly suspend: () => void };
  stationRemoteReportPump?: StationRemoteReportPump;
  hermes?: {
    readonly shutdown: { readonly drainOnQuit: () => Promise<unknown> };
  };
  kernel?: {
    readonly start: (host: KernelHost) => void;
    readonly suspend: () => void;
    readonly wakeManagedSeat: (
      canvasName: string,
      nodeId: string,
    ) => Promise<boolean>;
  };
  delivery?: { readonly dispose: () => void };
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
    // Mail was never configured on this process (CC-homed, unsupported);
    // only the pulse slot this process owns is cleared.
    setManagedPulseDeliver(undefined);
    try {
      handles.delivery?.dispose();
    } catch {
      // Best-effort unsubscription; process exit reclaims the rest.
    }
    try {
      handles.drive?.dispose();
    } catch {
      // Best-effort unsubscription; process exit reclaims the rest.
    }
    try {
      handles.drive?.suspend();
    } catch {
      // A suspended drive refuses later writes; shutdown continues regardless.
    }
    handles.overseer?.dispose();
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
    userData: process.env.JUNTO_HOME ?? process.env.HOME ?? process.cwd(),
    e2e: process.env.JUNTO_E2E === "1",
    headless: true,
    packaged: isRemotePackaged(resolveBinaryPath()),
    explicitHome: process.env.JUNTO_HOME,
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
    handles.overseer = await composeOverseer({
      run: RemoteRuntime.runPromise,
      captureApplicationPage: async () => ({
        ok: false,
        unavailable: true,
        reason: "Remote has no Command Center window to observe",
      }),
    });
    handles.workControl = await startWorkControlServer({
      version: remoteAppVersion(),
      run: (effect) => RemoteRuntime.runPromise(effect),
      onOverseer: handles.overseer.onOverseer,
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
      const pairing = await RemoteRuntime.runPromise(stations.pairing);
      const remoteInstallationId = await RemoteRuntime.runPromise(stations.installationId);
      if (pairing !== undefined && handles.overseer !== undefined) {
        handles.overseer.bindStationForward({
          control: handles.stationControl,
          remoteInstallationId,
          commandCenterInstallationId: pairing.commandCenterInstallationId,
        });
      }
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

  // Destination drive for managed prompts served over the term control
  // socket (overseer agent.prompt for Remote seats). Same shared recipe as
  // Command Center, wired to this installation's real observer/seat-state
  // evidence, with the same lifecycle ownership (ACK/drain/generation).
  // No clipboard preflight outside Electron (Grok image-trap unchecked, as
  // with the previous raw path); no remote cancellation identity — bounded
  // destination completion, and a client timeout never authorizes a repaste.
  const remoteDrive = createManagedTerminalDrive({
    write: (bindingId, data) =>
      termPlane.host.writeManagedSeat(bindingId, data),
    isSeatIdle: (bindingId) => seatStateRuntime.isSeatIdle(bindingId),
    seatState: (bindingId) => seatStateRuntime.getState(bindingId),
    onAttention: (bindingId, reason) => {
      if (!seatStateRuntime.machine.getSlot(bindingId)) return;
      seatStateRuntime.machine.force(bindingId, "attention", reason);
    },
    snapshot: (bindingId) => terminalObserverPlane.snapshot(bindingId),
    composerVerdict: (bindingId) =>
      seatStateRuntime.composerVerdict(bindingId),
    harnessFor: (bindingId) =>
      seatStateRuntime.machine.getSlot(bindingId)?.harness,
  });
  bindManagedTerminalDriveForOverseer(remoteDrive);
  const kernelForDelivery = handles.kernel;
  if (!kernelForDelivery) {
    console.error("[delivery] kernel plane missing; cannot compose delivery");
    await drainAndExit(1, "delivery-kernel-missing");
    return;
  }
  // Destination readiness: same positive-readiness gate as Command Center,
  // minus Electron-only layers (no automation suspension flag, no
  // clipboard preflight outside Electron).
  const remoteDriveReady = (bindingId: string): boolean => {
    const slot = seatStateRuntime.machine.getSlot(bindingId);
    return isManagedTerminalReady({
      harness: slot?.harness,
      seatState: seatStateRuntime.getState(bindingId),
      snapshot: terminalObserverPlane.snapshot(bindingId),
    });
  };
  // Factory delivery composition: kernel pulses, the injection supervisor,
  // board wakes, and first-typed doctrine reach Remote seats through this
  // installation's destination drive — the same shared recipe as Command
  // Center, no raw PTY bypass. Mailbox mail is Command Center-only: actor
  // mailboxes are CC-homed and a Remote never materializes message.append.
  const remoteDelivery = composeFactoryDelivery({
    drive: remoteDrive,
    driveReady: remoteDriveReady,
    kernel: kernelForDelivery,
    events: {
      subscribeSeatState: (listener) => seatStateRuntime.subscribe(listener),
      subscribeSnapshots: (listener) =>
        terminalObserverPlane.subscribeGlobal(listener),
    },
    supervisor: injectionSupervisor,
    escalate: (bindingId, reason) => {
      if (!seatStateRuntime.machine.getSlot(bindingId)) return;
      seatStateRuntime.machine.force(bindingId, "attention", reason, "high");
    },
    pulse: { setDeliver: setManagedPulseDeliver },
    board: { configure: configureBoardDelivery },
    firstTyped: {
      peekEntry: peekFirstTypedEntry,
      takeEntryIfCurrent: takeFirstTypedEntryIfCurrent,
      clearDeliveredForBinding,
    },
  });
  handles.delivery = { dispose: () => remoteDelivery.dispose() };
  // Same lifecycle ownership as Command Center (ACK/drain/generation),
  // plus the doctrine kick before the drive's own idle drain.
  const disposeDriveRuntime = attachManagedTerminalDriveRuntime(remoteDrive, {
    beforeSeatIdle: remoteDelivery.kickFirstTyped,
    subscribeHostEvents: (listener, options) =>
      termPlane.host.subscribeEvents((payload) => {
        if (payload.type === "output") {
          listener({ kind: "output", bindingId: payload.bindingId });
          return;
        }
        if (payload.type !== "session") return;
        listener({
          kind: "session",
          bindingId: payload.bindingId,
          exited: payload.status === "exited",
          running: payload.status === "running",
        });
      }, options),
    subscribeSeatState: (listener) =>
      seatStateRuntime.subscribe((event) =>
        listener({ bindingId: event.bindingId, state: event.state }),
      ),
    subscribeComposerEmpty: (listener) =>
      seatStateRuntime.subscribeComposerVerdict((bindingId, verdict) => {
        if (verdict !== "empty") return;
        listener(bindingId);
      }),
    harnessFor: (bindingId) =>
      seatStateRuntime.machine.getSlot(bindingId)?.harness,
    snapshotText: (bindingId) =>
      terminalObserverPlane.snapshot(bindingId)?.text,
  });
  handles.drive = {
    dispose: () => {
      try {
        remoteDelivery.dispose();
      } catch {
        // Best-effort unsubscription; process exit reclaims the rest.
      }
      disposeDriveRuntime();
    },
    suspend: () => remoteDrive.suspend(),
  };

  try {
    publishSystemdGenerationReadiness();
  } catch (error) {
    console.error("[readiness] systemd generation publish failed:", error);
    await drainAndExit(1, "systemd-readiness-failure");
    return;
  }

  console.error(
    `[junto-remote] running v${remoteAppVersion()} role=${
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
  console.error("[junto-remote] fatal:", error);
  process.exit(1);
});
