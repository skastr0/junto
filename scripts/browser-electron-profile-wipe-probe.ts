#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserProfileQuarantinePath } from "../src/main/vellum-command/browser/profile-storage";
import {
  createProbeSandbox,
  createProbeProcessSupervisor,
  removeProbeSandboxIfClean,
  type ProbeSandbox,
} from "./probe-process-supervisor";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(repoRoot, "tests/fixtures/browser/profile-wipe-sentinel.html");
const testMainEntryPath = join(
  repoRoot,
  "tests/fixtures/browser/electron-profile-wipe-main.ts",
);
const electronPath = join(repoRoot, "node_modules/.bin/electron");
const PROBE_TEMP_PREFIX = "/tmp/vpw-";
const MAX_LOG_BYTES = 128 * 1024;
const LAUNCH_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 190_000;
const PHASE_B_EXIT = 86;
const DISK_MARKER_NAME = ".vellum-profile-wipe-sentinel";
const probeSupervisor = createProbeProcessSupervisor({ maxLogBytes: MAX_LOG_BYTES });
const storageKeys = [
  "cookie",
  "localStorage",
  "indexedDb",
  "cacheStorage",
  "serviceWorker",
] as const;

type Profile = "personal" | "work";
type StorageKey = (typeof storageKeys)[number];
type SentinelSet = Readonly<Record<StorageKey, string>>;

interface PendingWipe {
  readonly wipeId: string;
  readonly storagePath: string;
}

interface LaunchResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly string[];
  readonly arguments: ReadonlyArray<string>;
}

let probeStage = "setup";
let activeServer: Server | undefined;
let activeSandbox: ProbeSandbox | undefined;
let watchdogExitRequested = false;
let normalCleanupCompleted = false;
let successfulProbeOutput: string | undefined;

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeSentinels = (): SentinelSet =>
  Object.freeze(
    Object.fromEntries(storageKeys.map((key) => [key, randomBytes(32).toString("base64url")])),
  ) as SentinelSet;

const allSentinels = (
  sentinels: Readonly<Record<Profile, SentinelSet>>,
): ReadonlyArray<string> => [
  ...storageKeys.map((key) => sentinels.personal[key]),
  ...storageKeys.map((key) => sentinels.work[key]),
];

const respond = (
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    expires: "0",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
};

const decodeProfile = (value: string | null): Profile | undefined =>
  value === "personal" || value === "work" ? value : undefined;

const startFixtureServer = async (
  fixture: string,
  sentinels: Readonly<Record<Profile, SentinelSet>>,
): Promise<{ readonly server: Server; readonly origin: string }> => {
  const pulseCounts = new Map<string, number>();
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET") {
        respond(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
        return;
      }
      if (url.pathname === "/profile-wipe/fixture.html") {
        respond(response, 200, "text/html; charset=utf-8", fixture);
        return;
      }
      if (url.pathname === "/profile-wipe/expected") {
        const profile = decodeProfile(url.searchParams.get("profile"));
        if (profile === undefined) {
          respond(response, 404, "application/json; charset=utf-8", "{}\n");
          return;
        }
        respond(
          response,
          200,
          "application/json; charset=utf-8",
          `${JSON.stringify(sentinels[profile])}\n`,
        );
        return;
      }
      if (url.pathname === "/profile-wipe/sw.js") {
        const profile = decodeProfile(url.searchParams.get("profile"));
        if (profile === undefined) {
          respond(response, 404, "text/javascript; charset=utf-8", "void 0;\n");
          return;
        }
        const workerBody = `"use strict";
const sentinel = ${JSON.stringify(sentinels[profile].serviceWorker)};
self.addEventListener("message", (event) => {
  if (event.data === "read" && event.ports[0]) event.ports[0].postMessage(sentinel);
});
`;
        respond(response, 200, "text/javascript; charset=utf-8", workerBody, {
          "service-worker-allowed": "/profile-wipe/",
        });
        return;
      }
      if (url.pathname === "/profile-wipe/pulse") {
        const token = url.searchParams.get("token");
        if (token === null || !/^[a-z0-9-]{1,32}$/.test(token)) {
          respond(response, 404, "text/plain; charset=utf-8", "not found\n");
          return;
        }
        pulseCounts.set(token, (pulseCounts.get(token) ?? 0) + 1);
        respond(response, 200, "text/plain; charset=utf-8", "ok\n");
        return;
      }
      if (url.pathname === "/profile-wipe/pulse-count") {
        const token = url.searchParams.get("token");
        if (token === null || !/^[a-z0-9-]{1,32}$/.test(token)) {
          respond(response, 404, "application/json; charset=utf-8", "{}\n");
          return;
        }
        respond(
          response,
          200,
          "application/json; charset=utf-8",
          `${JSON.stringify({ count: pulseCounts.get(token) ?? 0 })}\n`,
        );
        return;
      }
      respond(response, 404, "text/plain; charset=utf-8", "not found\n");
    } catch {
      respond(response, 500, "text/plain; charset=utf-8", "fixture failure\n");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  ensure(address !== null && typeof address === "object", "fixture_listener_invalid");
  return { server, origin: `http://127.0.0.1:${address.port}` };
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => server.close(() => resolveClose()));

const buildDedicatedElectronEntry = async (root: string): Promise<{
  readonly path: string;
  readonly stdout: string;
  readonly stderr: string;
}> => {
  const outputPath = join(root, "electron-profile-wipe-main.mjs");
  const build = probeSupervisor.spawnGroup({
    source: "browser-electron-profile-wipe-probe",
    purpose: "build dedicated Electron profile wipe entry",
    command: process.execPath,
    args: [
      "build",
      testMainEntryPath,
      "--target=node",
      "--format=esm",
      "--external=electron",
      `--outfile=${outputPath}`,
      "--sourcemap=none",
    ],
    cwd: repoRoot,
    env: process.env,
  });
  const { exitCode, signal, stdout, stderr } = await probeSupervisor.waitForClose(
    build,
    LAUNCH_TIMEOUT_MS,
    "electron_fixture_build_timeout",
  );
  ensure(exitCode === 0 && signal === null, "electron_fixture_build_failed");
  await access(outputPath);
  return { path: outputPath, stdout, stderr };
};

const launchElectron = async (options: {
  readonly phase: "A" | "B" | "C";
  readonly entryPath: string;
  readonly origin: string;
  readonly root: string;
  readonly userData: string;
  readonly browserRoot: string;
  readonly stateDatabasePath: string;
  readonly downloads: string;
  readonly reportPath: string;
  readonly markerInputPath: string;
}): Promise<LaunchResult> => {
  const args = [
    options.entryPath,
    `--user-data-dir=${options.userData}`,
    `--phase=${options.phase}`,
    `--fixture-origin=${options.origin}`,
    `--browser-root=${options.browserRoot}`,
    `--state-db-path=${options.stateDatabasePath}`,
    `--download-path=${options.downloads}`,
    `--report-path=${options.reportPath}`,
    `--marker-input-path=${options.markerInputPath}`,
  ];
  ensure(
    !args.some((argument) => /--(?:remote-debugging|inspect|inspect-brk)(?:=|$)/.test(argument)),
    "debug_authority_enabled",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(options.root, "home"),
    JUNTO_BROWSER_DIR: options.browserRoot,
  };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = probeSupervisor.spawnGroup({
    source: "browser-electron-profile-wipe-probe",
    purpose: `run Electron profile wipe phase ${options.phase}`,
    command: electronPath,
    args,
    cwd: repoRoot,
    env,
  });
  try {
    const close = await probeSupervisor.waitForClose(
      child,
      LAUNCH_TIMEOUT_MS,
      "electron_launch_timeout",
    );
    return { ...close, arguments: args };
  } catch (error) {
    await probeSupervisor.stop(child, `profile-wipe-phase-${options.phase}-failed`);
    throw error;
  }
};

const assertExit = (
  result: LaunchResult,
  expectedCode: number,
  phase: string,
): void => {
  ensure(result.exitCode === expectedCode && result.signal === null, `${phase}_exit_invalid`);
};

const readReport = async (
  path: string,
  phase: "A" | "B" | "C",
  expected: Readonly<Record<string, string | number>>,
): Promise<{ readonly encoded: string; readonly value: Record<string, unknown> }> => {
  const [metadata, encoded] = await Promise.all([stat(path), readFile(path, "utf8")]);
  ensure(metadata.isFile() && (metadata.mode & 0o777) === 0o600, `${phase}_report_mode_invalid`);
  const value = JSON.parse(encoded) as unknown;
  ensure(isRecord(value) && value.version === 1 && value.phase === phase, `${phase}_report_invalid`);
  if (value.result === "failed") {
    ensure(typeof value.failure === "string", `${phase}_child_failed`);
    throw new Error(`${phase}_child_${value.failure}`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    ensure(value[key] === expectedValue, `${phase}_report_assertion_failed`);
  }
  ensure(
    Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number"),
    `${phase}_report_not_enum_only`,
  );
  return { encoded, value };
};

const assertOwnerOnly = async (path: string, kind: "file" | "directory"): Promise<void> => {
  const metadata = await stat(path);
  const expectedKind = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  const ownedByProcess =
    typeof process.getuid !== "function" || metadata.uid === process.getuid();
  ensure(expectedKind && ownedByProcess && (metadata.mode & 0o077) === 0, "owner_mode_invalid");
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
};

const findDiskMarkers = async (root: string): Promise<ReadonlyArray<string>> => {
  const found: string[] = [];
  const pending = [root];
  let entriesSeen = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    ensure(directory !== undefined, "marker_walk_invalid");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entriesSeen += 1;
      ensure(entriesSeen <= 100_000, "marker_walk_limit");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === DISK_MARKER_NAME) found.push(path);
    }
  }
  return Object.freeze(found.sort());
};

const assertAbsent = (
  prohibited: ReadonlyArray<string>,
  artifacts: ReadonlyArray<readonly [string, string]>,
): void => {
  for (const [name, artifact] of artifacts) {
    ensure(
      prohibited.every((value) => value.length === 0 || !artifact.includes(value)),
      `public_artifact_leak_${name}`,
    );
  }
};

const publicLaunchArtifacts = (
  phase: string,
  launch: LaunchResult,
  report: string,
): ReadonlyArray<readonly [string, string]> => [
  [`${phase}_stdout`, launch.stdout],
  [`${phase}_stderr`, launch.stderr],
  [`${phase}_diagnostics`, JSON.stringify(launch.diagnostics)],
  [`${phase}_arguments`, JSON.stringify(launch.arguments)],
  [`${phase}_report`, report],
];

const main = async (): Promise<void> => {
  const sentinels = Object.freeze({
    personal: makeSentinels(),
    work: makeSentinels(),
  });
  const diskMarkers = Object.freeze({
    personal: randomBytes(32).toString("base64url"),
    work: randomBytes(32).toString("base64url"),
  });
  const secrets = [...allSentinels(sentinels), diskMarkers.personal, diskMarkers.work];
  ensure(new Set(secrets).size === secrets.length, "sentinels_not_unique");
  const sandbox = await createProbeSandbox(PROBE_TEMP_PREFIX);
  const root = sandbox.root;
  activeSandbox = sandbox;
  const home = join(root, "home");
  const userData = join(root, "electron");
  const browserRoot = join(root, "browser");
  const stateDatabasePath = join(root, "state", "junto.db");
  const downloads = join(root, "downloads");
  const reports = {
    A: join(root, "reports", "phase-a.json"),
    B: join(root, "reports", "phase-b.json"),
    C: join(root, "reports", "phase-c.json"),
  } as const;
  const markerInputPath = join(root, "private", "disk-markers.json");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(userData, { recursive: true, mode: 0o700 }),
    mkdir(browserRoot, { recursive: true, mode: 0o700 }),
    mkdir(downloads, { recursive: true, mode: 0o700 }),
    mkdir(dirname(markerInputPath), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(markerInputPath, `${JSON.stringify(diskMarkers)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await assertOwnerOnly(markerInputPath, "file");

  const fixture = await readFile(fixturePath, "utf8");
  const mainSource = await readFile(testMainEntryPath, "utf8");
  ensure(!mainSource.includes(".markCreated("), "manual_gate_mutation_present");
  const fixtureServer = await startFixtureServer(fixture, sentinels);
  activeServer = fixtureServer.server;
  try {
    probeStage = "build";
    const built = await buildDedicatedElectronEntry(root);
    assertAbsent(secrets, [
      ["build_stdout", built.stdout],
      ["build_stderr", built.stderr],
    ]);

    probeStage = "launch_A";
    const launchA = await launchElectron({
      phase: "A",
      entryPath: built.path,
      origin: fixtureServer.origin,
      root,
      userData,
      browserRoot,
      stateDatabasePath,
      downloads,
      reportPath: reports.A,
      markerInputPath,
    });
    const reportA = await readReport(reports.A, "A", {
      fiveBackendsPersonalAutomation: "match",
      fiveBackendsPersonalUi: "match",
      fiveBackendsWork: "match",
      stopPageRuntime: "destroyed",
      stopPagePulse: "halted",
      stopPageStorage: "match",
      stopPageSibling: "survived",
      wipeReachability: "session_service",
      wipeReceipt: "restart_required",
      personalUi: "quiesced",
      personalAutomation: "quiesced",
      personalCapability: "revoked_profile_wipe",
      workSession: "survived",
      workCapability: "active",
      workStorage: "match",
      diskMarkersBoth: "seeded",
      personalGate: "quiescing",
      workGate: "open",
      pendingStage: "restart_delete_pending",
      targetMode: "owner_only",
      stateDatabaseMode: "owner_only",
    });
    assertExit(launchA, 0, "phase_A");
    const wipeId = reportA.value.pendingWipeId;
    ensure(typeof wipeId === "string", "phase_A_wipe_id_invalid");
    const markersAfterA = await findDiskMarkers(userData);
    ensure(markersAfterA.length === 2, "phase_A_marker_count_invalid");
    const markerEntriesAfterA = await Promise.all(
      markersAfterA.map(async (path) => ({
        path,
        value: await readFile(path, "utf8"),
      })),
    );
    ensure(
      new Set(markerEntriesAfterA.map(({ value }) => value)).size === 2 &&
        markerEntriesAfterA.some(({ value }) => value === diskMarkers.personal) &&
        markerEntriesAfterA.some(({ value }) => value === diskMarkers.work),
      "phase_A_marker_contents_invalid",
    );
    const personalMarker = markerEntriesAfterA.find(
      ({ value }) => value === diskMarkers.personal,
    );
    ensure(personalMarker !== undefined, "phase_A_personal_marker_missing");
    const pending: PendingWipe = {
      wipeId,
      storagePath: dirname(personalMarker.path),
    };
    const quarantine = browserProfileQuarantinePath(pending.storagePath, pending.wipeId);
    ensure(quarantine !== undefined, "quarantine_path_invalid");
    ensure(await pathExists(pending.storagePath), "phase_A_target_missing");
    ensure(!(await pathExists(quarantine)), "phase_A_quarantine_premature");
    await assertOwnerOnly(pending.storagePath, "directory");
    await assertOwnerOnly(personalMarker.path, "file");
    await assertOwnerOnly(dirname(stateDatabasePath), "directory");
    await assertOwnerOnly(stateDatabasePath, "file");
    const prohibited = [...secrets, pending.storagePath, quarantine];
    assertAbsent(prohibited, publicLaunchArtifacts("phase_A", launchA, reportA.encoded));

    probeStage = "launch_B";
    const launchB = await launchElectron({
      phase: "B",
      entryPath: built.path,
      origin: fixtureServer.origin,
      root,
      userData,
      browserRoot,
      stateDatabasePath,
      downloads,
      reportPath: reports.B,
      markerInputPath,
    });
    assertExit(launchB, PHASE_B_EXIT, "phase_B");
    const reportB = await readReport(reports.B, "B", {
      failpoint: "armed_after_quarantine_rename",
      recovery: "armed",
      sessionConstruction: "none",
      sessionControl: "none",
      capabilityControl: "none",
      pendingStage: "restart_delete_pending",
      pendingWipeId: pending.wipeId,
      exit: "from_failpoint",
    });
    ensure(!(await pathExists(pending.storagePath)), "phase_B_target_survived");
    ensure(await pathExists(quarantine), "phase_B_quarantine_missing");
    await assertOwnerOnly(quarantine, "directory");
    const quarantinedMarker = join(quarantine, DISK_MARKER_NAME);
    ensure(
      (await readFile(quarantinedMarker, "utf8")) === diskMarkers.personal,
      "phase_B_quarantine_marker_invalid",
    );
    await assertOwnerOnly(quarantinedMarker, "file");
    assertAbsent(prohibited, publicLaunchArtifacts("phase_B", launchB, reportB.encoded));

    probeStage = "launch_C";
    const launchC = await launchElectron({
      phase: "C",
      entryPath: built.path,
      origin: fixtureServer.origin,
      root,
      userData,
      browserRoot,
      stateDatabasePath,
      downloads,
      reportPath: reports.C,
      markerInputPath,
    });
    const reportC = await readReport(reports.C, "C", {
      startupOrder: "recovery_before_session",
      firstRecovery: "complete",
      secondRecovery: "idempotent",
      sessionConstructionBeforeRecovery: "none",
      sessionControlBeforeRecovery: "none",
      capabilityControlBeforeRecovery: "none",
      recoveredTarget: "absent_before_recreate",
      recoveredQuarantine: "absent",
      deletedGate: "observed",
      recreation: "profile_service",
      manualGateMutation: "none",
      recreatedGate: "open",
      fiveBackendsPersonal: "absent",
      fiveBackendsWork: "match",
      personalDiskMarker: "absent",
      workDiskMarker: "match",
      recoveredWipeId: pending.wipeId,
      finalRegistry: "ready_without_journal",
      finalProfiles: "personal_and_work",
      browserRootMode: "owner_only",
      stateDatabaseMode: "owner_only",
    });
    assertExit(launchC, 0, "phase_C");
    ensure(!(await pathExists(quarantine)), "phase_C_quarantine_survived");
    ensure(
      !(await pathExists(join(pending.storagePath, DISK_MARKER_NAME))),
      "phase_C_personal_marker_survived",
    );
    const markersAfterC = await findDiskMarkers(userData);
    ensure(markersAfterC.length === 1, "phase_C_marker_count_invalid");
    ensure(
      (await readFile(markersAfterC[0]!, "utf8")) === diskMarkers.work,
      "phase_C_work_marker_invalid",
    );
    await assertOwnerOnly(markersAfterC[0]!, "file");
    await assertOwnerOnly(browserRoot, "directory");
    await assertOwnerOnly(dirname(stateDatabasePath), "directory");
    await assertOwnerOnly(stateDatabasePath, "file");
    assertAbsent(
      prohibited,
      publicLaunchArtifacts("phase_C", launchC, reportC.encoded),
    );

    const success = JSON.stringify({
      ok: true,
      assertions: {
        threeFreshElectronLaunches: true,
        fiveBackendsSeededInBothProfiles: true,
        stopPageDestroyedWebContents: true,
        stopPageHaltedPageJavascript: true,
        stopPagePreservedFiveStorageBackends: true,
        stopPagePreservedSiblingSession: true,
        profileWipeReachableThroughSessionService: true,
        liveWipeRestartRequired: true,
        profileWideUiAndAutomationQuiesced: true,
        profileCapabilityRevoked: true,
        siblingSessionCapabilityAndStorageSurvived: true,
        crashAfterDurableQuarantineRename: true,
        coldRecoveryConstructedNoSession: true,
        coldRecoveryResumedBeforeActivation: true,
        coldRecoveryIdempotent: true,
        recreationUsedProfileService: true,
        recreatedPersonalProfileBlankAcrossFiveBackends: true,
        workProfilePreservedAcrossFiveBackends: true,
        ownerOnlyModes: true,
        publicArtifactsContainNoSentinelsOrStoragePaths: true,
      },
    });
    assertAbsent(prohibited, [["success_output", success]]);
    successfulProbeOutput = success;
  } finally {
    fixtureServer.server.closeAllConnections();
    await closeServer(fixtureServer.server);
    if (activeServer === fixtureServer.server) activeServer = undefined;
    probeStage = "verify_process_group_drain";
    const drainReceipt = await probeSupervisor.shutdown(
      "profile-wipe-probe-finalize",
    );
    const removed = await removeProbeSandboxIfClean({
      sandbox,
      receipt: drainReceipt,
      label: "Electron profile wipe probe",
    });
    if (removed && activeSandbox === sandbox) activeSandbox = undefined;
    if (!drainReceipt.clean && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
      process.exitCode = 2;
    }
    normalCleanupCompleted = true;
  }
};

const watchdog = setTimeout(() => {
  watchdogExitRequested = true;
  console.error(JSON.stringify({ ok: false, stage: probeStage, error: "probe_timeout" }));
  void (async () => {
    const drainReceipt = await probeSupervisor.shutdown(
      "profile-wipe-probe-watchdog",
    );
    activeServer?.closeAllConnections();
    activeServer?.close();
    if (activeSandbox !== undefined) {
      await removeProbeSandboxIfClean({
        sandbox: activeSandbox,
        receipt: drainReceipt,
        label: "Electron profile wipe probe watchdog",
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        return false;
      });
    }
    process.exitCode = 124;
  })();
}, PROBE_TIMEOUT_MS);
watchdog.unref();

try {
  await main();
} catch (error: unknown) {
  const failure =
    error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.message)
      ? error.message
      : "profile_wipe_probe_failed";
  console.error(JSON.stringify({ ok: false, stage: probeStage, error: failure }));
  if (!watchdogExitRequested) process.exitCode = 2;
} finally {
  clearTimeout(watchdog);
  const finalReceipt = await probeSupervisor.shutdown(
    "profile-wipe-probe-top-level-finalize",
  );
  if (!normalCleanupCompleted) {
    activeServer?.closeAllConnections();
    activeServer?.close();
    if (activeSandbox !== undefined) {
      const removed = await removeProbeSandboxIfClean({
        sandbox: activeSandbox,
        receipt: finalReceipt,
        label: "Electron profile wipe top-level cleanup",
      });
      if (removed) activeSandbox = undefined;
    }
  }
  if (!finalReceipt.clean && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
    process.exitCode = 2;
  }
  if (
    successfulProbeOutput !== undefined &&
    finalReceipt.clean &&
    !watchdogExitRequested &&
    (process.exitCode ?? 0) === 0
  ) {
    console.log(successfulProbeOutput);
  }
}
