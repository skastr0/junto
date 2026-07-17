import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { app, session } from "electron";
import { Effect } from "effect";
import {
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
  type BrowserCapabilityTarget,
} from "../../../src/main/vellum/browser/capabilities";
import { makeBrowserProfileGate } from "../../../src/main/vellum/browser/profile-gate";
import {
  browserProfileQuarantinePath,
  makeBrowserProfileStorageLifecycle,
  type BrowserProfileStoragePlatform,
  type BrowserProfileStorageSessionControl,
} from "../../../src/main/vellum/browser/profile-storage";
import { makeElectronBrowserProfileStoragePlatform } from "../../../src/main/vellum/browser/profile-storage-electron";
import {
  makeBrowserProfileService,
  type BrowserProfilePendingWipe,
} from "../../../src/main/vellum/browser/profiles";
import type { ResolvedPageTarget } from "../../../src/main/vellum/browser/page-target";
import {
  BROWSER_UI_SESSION_OWNER,
  BrowserSessionService,
  type BrowserResult,
  type BrowserProfileQuiescence,
} from "../../../src/main/vellum/browser/sessions";
import { makeBrowserTestOnlyElectronHarness } from "../../../src/main/vellum/browser/view-adapter";
import { partitionNameForProfile } from "../../../src/shared/browser";
import { formatNodeRef } from "../../../src/shared/node-ref";

const requiredArgument = (name: string): string => {
  const prefix = `--${name}=`;
  const values = process.argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length !== 1 || values[0] === "") throw new Error("invalid_probe_arguments");
  return values[0];
};

const phase = requiredArgument("phase");
const exactOrigin = requiredArgument("fixture-origin");
const browserRoot = requiredArgument("browser-root");
const downloadPath = requiredArgument("download-path");
const reportPath = requiredArgument("report-path");
const markerInputPath = requiredArgument("marker-input-path");
const configPath = join(browserRoot, "config.json");
const EXPECTED_FAILPOINT_EXIT = 86;
const REPORT_TIMEOUT_MS = 15_000;
const DISK_MARKER_NAME = ".vellum-profile-wipe-sentinel";
const DISK_MARKER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const storageKeys = [
  "cookie",
  "localStorage",
  "indexedDb",
  "cacheStorage",
  "serviceWorker",
] as const;

type StorageKey = (typeof storageKeys)[number];
type StorageStatus = "match" | "absent" | "mismatch";
type StorageReport = Readonly<Record<StorageKey, StorageStatus>>;
type DiskMarkers = Readonly<Record<"personal" | "work", string>>;

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
};

const ownerOnly = async (path: string, kind: "file" | "directory"): Promise<boolean> => {
  const metadata = await lstat(path);
  const expectedKind = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  const ownedByProcess =
    typeof process.getuid !== "function" || metadata.uid === process.getuid();
  return expectedKind && ownedByProcess && (metadata.mode & 0o077) === 0;
};

const writeReport = async (value: unknown): Promise<void> => {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, reportPath);
};

const decodePending = (value: unknown): BrowserProfilePendingWipe => {
  ensure(isRecord(value) && value.phase === "wipe_pending", "pending_config_required");
  const pending = value.pendingWipe;
  ensure(isRecord(pending), "pending_record_required");
  for (const key of [
    "wipeId",
    "profileId",
    "partition",
    "requestedAt",
    "stage",
    "storagePath",
    "userDataPath",
    "sessionDataPath",
  ] as const) {
    ensure(typeof pending[key] === "string", "pending_record_invalid");
  }
  ensure(isAbsolute(pending.storagePath as string), "pending_record_invalid");
  ensure(isAbsolute(pending.userDataPath as string), "pending_record_invalid");
  ensure(isAbsolute(pending.sessionDataPath as string), "pending_record_invalid");
  return pending as unknown as BrowserProfilePendingWipe;
};

const readPending = async (): Promise<BrowserProfilePendingWipe> =>
  decodePending(JSON.parse(await readFile(configPath, "utf8")));

const readDiskMarkers = async (): Promise<DiskMarkers> => {
  const value = JSON.parse(await readFile(markerInputPath, "utf8")) as unknown;
  ensure(isRecord(value), "disk_markers_invalid");
  ensure(
    typeof value.personal === "string" &&
      DISK_MARKER_PATTERN.test(value.personal) &&
      typeof value.work === "string" &&
      DISK_MARKER_PATTERN.test(value.work) &&
      value.personal !== value.work,
    "disk_markers_invalid",
  );
  return Object.freeze({ personal: value.personal, work: value.work });
};

const decodeStorageReport = (value: unknown): StorageReport => {
  ensure(isRecord(value) && value.ready === true, "storage_report_not_ready");
  if (value.error !== undefined) {
    ensure(typeof value.error === "string" && /^[a-z0-9_]+$/.test(value.error), "storage_report_failed");
    throw new Error(value.error);
  }
  for (const key of storageKeys) {
    ensure(
      value[key] === "match" || value[key] === "absent" || value[key] === "mismatch",
      "storage_report_invalid",
    );
  }
  return Object.freeze(
    Object.fromEntries(storageKeys.map((key) => [key, value[key]])),
  ) as StorageReport;
};

const allStorage = (report: StorageReport, expected: StorageStatus): boolean =>
  storageKeys.every((key) => report[key] === expected);

const target = (
  nodeId: string,
  profile: "personal" | "work",
  mode: "seed" | "read" | "blank",
): ResolvedPageTarget => ({
  ref: formatNodeRef({ canvasName: "browser-profile-wipe", nodeId }),
  nodeId,
  url: `${exactOrigin}/profile-wipe/fixture.html?mode=${mode}&profile=${profile}`,
  profile,
});

const requireResult = <A>(result: BrowserResult<A>, code: string): A => {
  ensure(result.ok, code);
  return result.data;
};

const waitForStorageReport = async (
  sessions: BrowserSessionService,
  owner: string,
  sessionId: string,
): Promise<StorageReport> => {
  requireResult(
    await sessions.awaitNavigationTerminalForOwner(owner, sessionId),
    "navigation_failed",
  );
  const deadline = Date.now() + REPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const evaluated = await sessions.evalForOwner(
      owner,
      sessionId,
      `(() => {
        const node = document.getElementById("vellum-profile-wipe-report");
        if (node?.dataset.ready !== "true") return null;
        return JSON.parse(node.textContent || "null");
      })()`,
    );
    if (evaluated.ok && evaluated.data.result !== null) {
      return decodeStorageReport(evaluated.data.result);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("storage_report_timeout");
};

const openAndRead = async (
  sessions: BrowserSessionService,
  owner: string,
  page: ResolvedPageTarget,
): Promise<{ readonly sessionId: string; readonly report: StorageReport }> => {
  const opened = requireResult(
    owner === BROWSER_UI_SESSION_OWNER
      ? await sessions.open(page)
      : await sessions.openForOwner(owner, page),
    "session_open_failed",
  );
  return {
    sessionId: opened.sessionId,
    report: await waitForStorageReport(sessions, owner, opened.sessionId),
  };
};

const flushProfile = async (profile: "personal" | "work"): Promise<void> => {
  const partition = session.fromPartition(partitionNameForProfile(profile));
  partition.flushStorageData();
  await partition.cookies.flushStore();
};

const persistentStorageRoot = async (profile: "personal" | "work"): Promise<string> => {
  const storagePath = session.fromPartition(partitionNameForProfile(profile)).getStoragePath();
  ensure(
    typeof storagePath === "string" &&
      isAbsolute(storagePath) &&
      resolve(storagePath) === storagePath,
    "storage_root_invalid",
  );
  const roots = makeElectronBrowserProfileStoragePlatform().currentRoots();
  const fromSessionData = relative(roots.sessionDataPath, storagePath);
  ensure(
    fromSessionData.length > 0 &&
      !fromSessionData.startsWith("..") &&
      !isAbsolute(fromSessionData),
    "storage_root_outside_session_data",
  );
  ensure(await ownerOnly(storagePath, "directory"), "storage_root_not_owner_only");
  return storagePath;
};

const writeDiskMarker = async (
  profile: "personal" | "work",
  value: string,
): Promise<string> => {
  const storagePath = await persistentStorageRoot(profile);
  const markerPath = join(storagePath, DISK_MARKER_NAME);
  await writeFile(markerPath, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(markerPath, 0o600);
  ensure(await ownerOnly(markerPath, "file"), "disk_marker_not_owner_only");
  return storagePath;
};

const makeTarget = (
  page: ResolvedPageTarget,
): BrowserCapabilityTarget => ({
  ref: page.ref,
  profile: page.profile,
  exactOrigins: [exactOrigin],
});

const runPhaseA = async (): Promise<void> => {
  const gate = makeBrowserProfileGate();
  let sessions: BrowserSessionService | undefined;
  const capabilities = makeBrowserCapabilityRegistry({
    profileGate: gate,
    onTerminate: (notice) => {
      sessions?.destroyOwnerSessions(notice.ownerId, "profile capability ended");
    },
  });
  const sessionControl: BrowserProfileStorageSessionControl = {
    beginProfileQuiescence: (
      profile: string,
      reason?: string,
    ): BrowserResult<BrowserProfileQuiescence> => {
      ensure(sessions !== undefined, "sessions_not_bound");
      return sessions.beginProfileQuiescence(profile, reason);
    },
  };
  const storage = makeBrowserProfileStorageLifecycle({
    platform: makeElectronBrowserProfileStoragePlatform(),
    sessions: sessionControl,
    capabilities,
    profileGate: gate,
  });
  const profiles = makeBrowserProfileService(browserRoot, {
    wipeLifecycle: storage,
    profileGate: gate,
  });
  await Effect.runPromise(profiles.ensureDefaults);
  const harness = makeBrowserTestOnlyElectronHarness(exactOrigin, downloadPath);
  sessions = new BrowserSessionService(
    harness.adapter,
    profiles,
    Date.now,
    randomUUID,
    harness.targetAdmission,
    gate,
  );

  const personalSeed = target("personal-automation-seed", "personal", "seed");
  const personalRead = target("personal-ui-read", "personal", "read");
  const workSeed = target("work-automation-seed", "work", "seed");
  const personalPrincipal = capabilities.createPrincipal();
  const workPrincipal = capabilities.createPrincipal();
  const personalGrant = capabilities.issue(personalPrincipal, {
    actions: ["open", "sessions", "eval"],
    targets: [makeTarget(personalSeed)],
    ttlMs: 5 * 60_000,
    maxUses: 128,
    maxInFlight: 4,
  });
  const workGrant = capabilities.issue(workPrincipal, {
    actions: ["open", "sessions", "eval"],
    targets: [makeTarget(workSeed)],
    ttlMs: 5 * 60_000,
    maxUses: 128,
    maxInFlight: 4,
  });

  const personalAutomation = await openAndRead(
    sessions,
    personalPrincipal.ownerId,
    personalSeed,
  );
  const personalUi = await openAndRead(sessions, BROWSER_UI_SESSION_OWNER, personalRead);
  const workAutomation = await openAndRead(sessions, workPrincipal.ownerId, workSeed);
  ensure(allStorage(personalAutomation.report, "match"), "personal_seed_failed");
  ensure(allStorage(personalUi.report, "match"), "personal_cross_owner_failed");
  ensure(allStorage(workAutomation.report, "match"), "work_seed_failed");
  await flushProfile("personal");
  await flushProfile("work");
  const diskMarkers = await readDiskMarkers();
  const personalStorageRoot = await writeDiskMarker("personal", diskMarkers.personal);
  await writeDiskMarker("work", diskMarkers.work);

  const receipt = await Effect.runPromise(profiles.wipeProfile("personal"));
  ensure(receipt.status === "restart_required", "restart_required_expected");
  const personalOwnerSessions = requireResult(
    sessions.listForOwner(personalPrincipal.ownerId),
    "personal_sessions_failed",
  );
  const uiSessions = requireResult(sessions.list(), "ui_sessions_failed");
  const workOwnerSessions = requireResult(
    sessions.listForOwner(workPrincipal.ownerId),
    "work_sessions_failed",
  );
  ensure(personalOwnerSessions.length === 0, "personal_automation_not_quiesced");
  ensure(uiSessions.every((entry) => entry.profile !== "personal"), "personal_ui_not_quiesced");
  ensure(
    workOwnerSessions.length === 1 &&
      workOwnerSessions[0]?.sessionId === workAutomation.sessionId,
    "work_session_not_preserved",
  );
  const workAfterWipe = await waitForStorageReport(
    sessions,
    workPrincipal.ownerId,
    workAutomation.sessionId,
  );
  ensure(allStorage(workAfterWipe, "match"), "work_storage_not_preserved");
  ensure(
    !capabilities.preflight(personalGrant.secret, "sessions", personalPrincipal).ok,
    "personal_capability_not_revoked",
  );
  ensure(
    capabilities.preflight(workGrant.secret, "sessions", workPrincipal).ok,
    "work_capability_not_preserved",
  );
  ensure(gate.disposition("personal") === "quiescing", "personal_gate_not_quiescing");
  ensure(gate.disposition("work") === "open", "work_gate_not_open");
  const pending = await readPending();
  ensure(pending.stage === "restart_delete_pending", "pending_stage_invalid");
  ensure(pending.storagePath === personalStorageRoot, "pending_target_mismatch");
  ensure(await pathExists(pending.storagePath), "live_target_missing");
  ensure(
    (await readFile(join(pending.storagePath, DISK_MARKER_NAME), "utf8")) ===
      diskMarkers.personal,
    "personal_disk_marker_changed",
  );
  ensure(await ownerOnly(pending.storagePath, "directory"), "live_target_not_owner_only");
  const revoked = capabilities.auditSnapshot().some(
    (event) =>
      event.auditId === personalGrant.auditId && event.outcome === "revoked_profile_wipe",
  );
  ensure(revoked, "profile_revocation_audit_missing");

  await writeReport({
    version: 1,
    phase: "A",
    fiveBackendsPersonalAutomation: "match",
    fiveBackendsPersonalUi: "match",
    fiveBackendsWork: "match",
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
  });
  sessions.detachAllOnQuit("profile wipe phase A complete");
  capabilities.close();
};

const makeColdOnlyPlatform = (counter: { sessionConstructions: number }): BrowserProfileStoragePlatform => {
  const electron = makeElectronBrowserProfileStoragePlatform();
  return Object.freeze({
    currentRoots: electron.currentRoots,
    sessionForPartition: () => {
      counter.sessionConstructions += 1;
      throw new Error("cold_recovery_constructed_session");
    },
  });
};

const makeColdOnlySessions = (
  counter: { sessionControls: number },
): BrowserProfileStorageSessionControl => ({
  beginProfileQuiescence: () => {
    counter.sessionControls += 1;
    throw new Error("cold_recovery_touched_session_control");
  },
});

const makeColdOnlyCapabilities = (counter: { capabilityControls: number }) => ({
  revokeByProfile: (): number => {
    counter.capabilityControls += 1;
    throw new Error("cold_recovery_touched_capability_control");
  },
});

const runPhaseB = async (): Promise<void> => {
  const pending = await readPending();
  const quarantine = browserProfileQuarantinePath(pending.storagePath, pending.wipeId);
  ensure(quarantine !== undefined, "quarantine_path_invalid");
  ensure(await pathExists(pending.storagePath), "pre_crash_target_missing");
  ensure(!(await pathExists(quarantine)), "pre_crash_quarantine_present");
  const calls = { sessionConstructions: 0, sessionControls: 0, capabilityControls: 0 };
  const gate = makeBrowserProfileGate();
  const storage = makeBrowserProfileStorageLifecycle({
    platform: makeColdOnlyPlatform(calls),
    sessions: makeColdOnlySessions(calls),
    capabilities: makeColdOnlyCapabilities(calls),
    profileGate: gate,
    failpoints: {
      afterQuarantineRename: () => {
        app.exit(EXPECTED_FAILPOINT_EXIT);
        throw new Error("failpoint_exit_returned");
      },
    },
  });
  const profiles = makeBrowserProfileService(browserRoot, {
    wipeLifecycle: storage,
    profileGate: gate,
  });
  await writeReport({
    version: 1,
    phase: "B",
    failpoint: "armed_after_quarantine_rename",
    recovery: "armed",
    sessionConstruction: "none",
    sessionControl: "none",
    capabilityControl: "none",
    pendingStage: "restart_delete_pending",
    exit: "from_failpoint",
  });
  await Effect.runPromise(profiles.recoverPendingWipe);
  throw new Error("failpoint_not_observed");
};

const runPhaseC = async (): Promise<void> => {
  const pending = await readPending();
  const quarantine = browserProfileQuarantinePath(pending.storagePath, pending.wipeId);
  ensure(quarantine !== undefined, "quarantine_path_invalid");
  const calls = { sessionConstructions: 0, sessionControls: 0, capabilityControls: 0 };
  const gate = makeBrowserProfileGate();
  const storage = makeBrowserProfileStorageLifecycle({
    platform: makeColdOnlyPlatform(calls),
    sessions: makeColdOnlySessions(calls),
    capabilities: makeColdOnlyCapabilities(calls),
    profileGate: gate,
  });
  const profiles = makeBrowserProfileService(browserRoot, {
    wipeLifecycle: storage,
    profileGate: gate,
  });
  await Effect.runPromise(profiles.recoverPendingWipe);
  ensure(calls.sessionConstructions === 0, "cold_session_constructed");
  ensure(calls.sessionControls === 0, "cold_session_control_used");
  ensure(calls.capabilityControls === 0, "cold_capability_control_used");
  ensure(!(await pathExists(pending.storagePath)), "cold_target_survived");
  ensure(!(await pathExists(quarantine)), "cold_quarantine_survived");
  ensure(gate.disposition("personal") === "deleted", "cold_gate_not_deleted");
  await Effect.runPromise(profiles.recoverPendingWipe);
  ensure(calls.sessionConstructions === 0, "idempotence_constructed_session");
  ensure(calls.sessionControls === 0, "idempotence_touched_sessions");
  ensure(calls.capabilityControls === 0, "idempotence_touched_capabilities");
  await Effect.runPromise(profiles.createProfile("personal", "Personal"));
  ensure(gate.disposition("personal") === "open", "create_did_not_reopen_gate");

  let sessions: BrowserSessionService | undefined;
  const capabilities = makeBrowserCapabilityRegistry({
    profileGate: gate,
    onTerminate: (notice) => {
      sessions?.destroyOwnerSessions(notice.ownerId, "profile capability ended");
    },
  });
  const harness = makeBrowserTestOnlyElectronHarness(exactOrigin, downloadPath);
  sessions = new BrowserSessionService(
    harness.adapter,
    profiles,
    Date.now,
    randomUUID,
    harness.targetAdmission,
    gate,
  );
  const personalBlank = target("personal-automation-blank", "personal", "blank");
  const workRead = target("work-automation-read", "work", "read");
  const personalPrincipal = capabilities.createPrincipal();
  const workPrincipal = capabilities.createPrincipal();
  capabilities.issue(personalPrincipal, {
    actions: ["open", "sessions", "eval"],
    targets: [makeTarget(personalBlank)],
    ttlMs: 5 * 60_000,
    maxUses: 128,
    maxInFlight: 4,
  });
  capabilities.issue(workPrincipal, {
    actions: ["open", "sessions", "eval"],
    targets: [makeTarget(workRead)],
    ttlMs: 5 * 60_000,
    maxUses: 128,
    maxInFlight: 4,
  });
  let personal: Awaited<ReturnType<typeof openAndRead>>;
  try {
    personal = await openAndRead(sessions, personalPrincipal.ownerId, personalBlank);
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "report_failed";
    throw new Error(`personal_blank_${reason}`);
  }
  let work: Awaited<ReturnType<typeof openAndRead>>;
  try {
    work = await openAndRead(sessions, workPrincipal.ownerId, workRead);
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "report_failed";
    throw new Error(`work_survival_${reason}`);
  }
  ensure(allStorage(personal.report, "absent"), "personal_storage_not_blank");
  ensure(allStorage(work.report, "match"), "work_storage_not_preserved");
  const diskMarkers = await readDiskMarkers();
  const personalStorageRoot = await persistentStorageRoot("personal");
  const workStorageRoot = await persistentStorageRoot("work");
  ensure(personalStorageRoot === pending.storagePath, "recreated_target_mismatch");
  ensure(
    !(await pathExists(join(personalStorageRoot, DISK_MARKER_NAME))),
    "personal_disk_marker_survived",
  );
  ensure(
    (await readFile(join(workStorageRoot, DISK_MARKER_NAME), "utf8")) === diskMarkers.work,
    "work_disk_marker_changed",
  );
  await flushProfile("personal");
  await flushProfile("work");
  const finalConfigEncoded = await readFile(configPath, "utf8");
  const finalConfig = JSON.parse(finalConfigEncoded) as unknown;
  ensure(isRecord(finalConfig) && finalConfig.phase === "ready", "final_config_not_ready");
  ensure(finalConfig.pendingWipe === undefined, "final_config_retained_journal");
  ensure(!finalConfigEncoded.includes(pending.storagePath), "final_config_retained_target");
  ensure(!finalConfigEncoded.includes(quarantine), "final_config_retained_quarantine");
  ensure(await ownerOnly(browserRoot, "directory"), "browser_root_not_owner_only");
  ensure(await ownerOnly(configPath, "file"), "browser_config_not_owner_only");

  await writeReport({
    version: 1,
    phase: "C",
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
    finalConfig: "ready_without_journal",
    browserRootMode: "owner_only",
    configMode: "owner_only",
  });
  sessions.detachAllOnQuit("profile wipe phase C complete");
  capabilities.close();
};

for (const path of [browserRoot, downloadPath, reportPath, markerInputPath]) {
  ensure(isAbsolute(path), "probe_path_not_absolute");
}
ensure(phase === "A" || phase === "B" || phase === "C", "probe_phase_invalid");
const origin = new URL(exactOrigin);
ensure(
  origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.origin === exactOrigin,
  "probe_origin_invalid",
);

let quitting = false;
for (const signalName of ["SIGTERM", "SIGINT"] as const) {
  process.on(signalName, () => {
    if (quitting) return;
    quitting = true;
    app.quit();
  });
}

void app.whenReady().then(async () => {
  await mkdir(downloadPath, { recursive: true, mode: 0o700 });
  if (phase === "A") await runPhaseA();
  if (phase === "B") await runPhaseB();
  if (phase === "C") await runPhaseC();
  if (!quitting) {
    quitting = true;
    app.quit();
  }
}).catch(async (error: unknown) => {
  const failure =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "phase_failed";
  await writeReport({ version: 1, phase, result: "failed", failure }).catch(() => undefined);
  app.exit(2);
});
