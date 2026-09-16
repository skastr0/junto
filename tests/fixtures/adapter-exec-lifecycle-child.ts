import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AdapterExecModule from "../../src/main/junto/adapters/exec";
import type * as AppProcessPlaneModule from "../../src/main/junto/app-process-plane";
import type * as ProcessEpochModule from "../../src/main/junto/process-epoch";

const adapterExecModulePath = "../../src/main/junto/adapters/exec" + ".ts";
const {
  resolvedSpawnEnv,
  runCli,
  terminateAdapterChildrenOnQuit,
} = (await import(adapterExecModulePath)) as typeof AdapterExecModule;
const appProcessPlaneModulePath = "../../src/main/junto/app-process-plane" + ".ts";
const { appProcessPlane } = (await import(
  appProcessPlaneModulePath
)) as typeof AppProcessPlaneModule;
const processEpochModulePath = "../../src/main/junto/process-epoch" + ".ts";
const { setProcessEpochReaderForTests } = (await import(
  processEpochModulePath
)) as typeof ProcessEpochModule;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const pathExists = (targetPath: string): Promise<boolean> =>
  stat(targetPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const processGoneOrZombie = (pid: number): boolean => {
  if (!processAlive(pid)) return true;
  const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
  }).stdout.trim();
  return status.startsWith("Z");
};

const waitUntil = async (
  label: string,
  check: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`adapter lifecycle fixture timed out: ${label}`);
};

const root = await mkdtemp(join(tmpdir(), "vellum-adapter-exec-"));
const markerPath = join(root, "late-spawned");
const workerPath = join(import.meta.dirname, "adapter-exec-worker.ts");

const readGrandchildPid = async (path: string): Promise<number> => {
  const receipt = JSON.parse(await readFile(path, "utf8")) as {
    readonly grandchildPid: number;
  };
  await rm(path, { force: true });
  return receipt.grandchildPid;
};

const runGroupObservationScenario = async () => {
  const gracefulStartedAt = Date.now();
  const graceful = await runCli(process.execPath, [workerPath, "graceful-100"], 1_000);
  const gracefulSettledWithinBound = Date.now() - gracefulStartedAt < 1_500;
  const failedSpawn = await runCli("/definitely-missing-vellum-adapter-command", [], 1_000);

  const inheritedPidsPath = join(root, "inherited-pids.json");
  const inherited = await runCli(
    process.execPath,
    [workerPath, "leader-exits-first-ignore-term", inheritedPidsPath],
    30_000,
  );
  const inheritedGrandchildPid = await readGrandchildPid(inheritedPidsPath);
  const inheritedGrandchildAliveWhenSettled = processAlive(inheritedGrandchildPid);

  const closedPidsPath = join(root, "closed-pids.json");
  const closed = await runCli(
    process.execPath,
    [workerPath, "leader-exits-first-closed", closedPidsPath],
    30_000,
  );
  const closedGrandchildPid = await readGrandchildPid(closedPidsPath);
  const closedGrandchildAliveWhenSettled = processAlive(closedGrandchildPid);

  const activePidsPath = join(root, "active-pids.json");
  const pending = runCli(
    process.execPath,
    [workerPath, "parent-ignore-term", activePidsPath],
    30_000,
  );
  await waitUntil("pending pids", () => pathExists(activePidsPath));
  const activePids = JSON.parse(await readFile(activePidsPath, "utf8")) as {
    readonly parentPid: number;
    readonly grandchildPid: number;
  };

  const activeCleanupStartedAt = Date.now();
  const drain = terminateAdapterChildrenOnQuit();
  const repeatedQuitCoalesced = drain === terminateAdapterChildrenOnQuit();
  const appDrain = appProcessPlane.drainOnQuit();
  const pendingResult = await pending;
  const drainResult = await drain;
  const inheritedAliveAtAdapterDrain = processAlive(inheritedGrandchildPid);
  const closedAliveAtAdapterDrain = processAlive(closedGrandchildPid);
  await waitUntil(
    "active group reaped",
    () => processGoneOrZombie(activePids.parentPid) &&
      processGoneOrZombie(activePids.grandchildPid),
  );
  const activeGroupReapedBeforeHardExpiry = Date.now() - activeCleanupStartedAt < 1_500;
  const appDrainResult = await appDrain;
  const inheritedAliveAtAppDrain = processAlive(inheritedGrandchildPid);
  const closedAliveAtAppDrain = processAlive(closedGrandchildPid);

  await waitUntil("inherited-pipe original group drained", () =>
    !processAlive(inheritedGrandchildPid)
  );
  await waitUntil("stdio-closed original group drained", () =>
    !processAlive(closedGrandchildPid)
  );
  const adapterRetry = await terminateAdapterChildrenOnQuit();
  const appConvergedDrain = await appProcessPlane.drainOnQuit();

  const lateResult = await runCli(
    process.execPath,
    [workerPath, "marker", markerPath],
    1_000,
  );
  return {
    gracefulOk: graceful.ok,
    gracefulSettledWithinBound,
    failedSpawnOk: failedSpawn.ok,
    adapterDrainSettled: drainResult.settled,
    adapterDrainPending: drainResult.pending,
    adapterDrainScope: drainResult.scope,
    repeatedQuitCoalesced,
    inheritedResultOk: inherited.ok,
    inheritedError: inherited.error,
    inheritedGrandchildAliveWhenSettled,
    inheritedAliveAtAdapterDrain,
    inheritedAliveAtAppDrain,
    closedResultOk: closed.ok,
    closedGrandchildAliveWhenSettled,
    closedAliveAtAdapterDrain,
    closedAliveAtAppDrain,
    pendingOk: pendingResult.ok,
    pendingError: pendingResult.error,
    parentAlive: processAlive(activePids.parentPid),
    activeGrandchildAlive: processAlive(activePids.grandchildPid),
    activeGroupReapedBeforeHardExpiry,
    appDrainClean: appDrainResult.clean,
    appDrainStragglerStates: appDrainResult.stragglers.map((entry) => entry.state),
    adapterRetrySettled: adapterRetry.settled,
    adapterRetryPending: adapterRetry.pending,
    adapterRetryScope: adapterRetry.scope,
    appConvergedDrainClean: appConvergedDrain.clean,
    appConvergedStragglers: appConvergedDrain.stragglers.length,
    lateOk: lateResult.ok,
    lateError: lateResult.error,
    markerCreated: await pathExists(markerPath),
  };
};

const runOwnershipUnverifiedScenario = async () => {
  // Resolve the login-shell probe before replacing the read-only epoch seam.
  // Its already-closed central tombstone may also be visible in the later
  // global receipt; adapter-domain settlement must remain independent of it.
  await resolvedSpawnEnv();
  let snapshotCalls = 0;
  setProcessEpochReaderForTests({
    snapshot: (pidHint) => {
      snapshotCalls += 1;
      if (snapshotCalls !== 1 || pidHint === undefined) return undefined;
      return [{
        pid: pidHint,
        processGroupId: pidHint,
        sessionId: 23,
        startKey: "coherent-spawn-epoch",
      }];
    },
  });

  const result = await runCli(
    process.execPath,
    [workerPath, "graceful-100"],
    1_000,
  );
  const adapterDrain = await terminateAdapterChildrenOnQuit();
  const appDrain = await appProcessPlane.drainOnQuit();
  return {
    resultOk: result.ok,
    snapshotCalls,
    adapterDrainSettled: adapterDrain.settled,
    adapterDrainPending: adapterDrain.pending,
    adapterDrainScope: adapterDrain.scope,
    appDrainClean: appDrain.clean,
    appDrainStragglerStates: appDrain.stragglers.map((entry) => entry.state),
  };
};

try {
  const receipt = process.argv[2] === "ownership-unverified"
    ? await runOwnershipUnverifiedScenario()
    : await runGroupObservationScenario();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  setProcessEpochReaderForTests(undefined);
  await rm(root, { recursive: true, force: true });
}
