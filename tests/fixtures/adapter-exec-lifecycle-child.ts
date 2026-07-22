import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AdapterExecModule from "../../src/main/vellum/adapters/exec";

const adapterExecModulePath = "../../src/main/vellum/adapters/exec" + ".ts";
const { runCli, terminateAdapterChildrenOnQuit } = (await import(
  adapterExecModulePath
)) as typeof AdapterExecModule;

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
  const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).stdout.trim();
  return status.startsWith("Z");
};

const waitUntil = async (label: string, check: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`adapter lifecycle fixture timed out: ${label}`);
};

const root = await mkdtemp(join(tmpdir(), "vellum-adapter-exec-"));
const pidsPath = join(root, "pids.json");
const markerPath = join(root, "late-spawned");
const workerPath = join(import.meta.dirname, "adapter-exec-worker.ts");

try {
  const gracefulStartedAt = Date.now();
  const graceful = await runCli(process.execPath, [workerPath, "graceful-100"], 1_000);
  const gracefulSettledWithinBound = Date.now() - gracefulStartedAt < 500;
  const failedSpawn = await runCli("/definitely-missing-vellum-adapter-command", [], 1_000);

  const leader = await runCli(
    process.execPath,
    [workerPath, "leader-exits-first-ignore-term", pidsPath],
    30_000,
  );
  const leaderPids = JSON.parse(await readFile(pidsPath, "utf8")) as {
    readonly grandchildPid: number;
  };
  const leaderGrandchildAliveWhenSettled = processAlive(leaderPids.grandchildPid);
  // Group authority intentionally refuses a leaderless group: a later pid
  // reuse must not turn cleanup into an unrelated negative group signal.
  const leaderExitedGrandchildAlive = processAlive(leaderPids.grandchildPid);
  await rm(pidsPath, { force: true });

  const pending = runCli(
    process.execPath,
    [workerPath, "parent-ignore-term", pidsPath],
    30_000,
  );
  await waitUntil("pending pids", () => pathExists(pidsPath));
  const pids = JSON.parse(await readFile(pidsPath, "utf8")) as {
    readonly parentPid: number;
    readonly grandchildPid: number;
  };

  const activeCleanupStartedAt = Date.now();
  const drain = terminateAdapterChildrenOnQuit();
  const repeatedQuitCoalesced = drain === terminateAdapterChildrenOnQuit();
  const pendingResult = await pending;
  await waitUntil(
    "active group reaped",
    () => processGoneOrZombie(pids.parentPid) && processGoneOrZombie(pids.grandchildPid),
  );
  const activeGroupReapedBeforeHardExpiry = Date.now() - activeCleanupStartedAt < 1_500;
  const drainResult = await drain;

  const lateResult = await runCli(
    process.execPath,
    [workerPath, "marker", markerPath],
    1_000,
  );
  const receipt = {
    gracefulOk: graceful.ok,
    gracefulSettledWithinBound,
    failedSpawnOk: failedSpawn.ok,
    drainClean: drainResult.clean,
    repeatedQuitCoalesced,
    leaderResultOk: leader.ok,
    leaderError: leader.error,
    leaderGrandchildAliveWhenSettled,
    leaderExitedGrandchildAlive,
    pendingOk: pendingResult.ok,
    parentAlive: processAlive(pids.parentPid),
    grandchildAlive: processAlive(pids.grandchildPid),
    activeGroupReapedBeforeHardExpiry,
    lateOk: lateResult.ok,
    lateError: lateResult.error,
    markerCreated: await pathExists(markerPath),
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
