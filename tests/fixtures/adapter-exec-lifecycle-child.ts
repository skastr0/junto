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

const waitUntil = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error("adapter lifecycle fixture timed out");
};

const root = await mkdtemp(join(tmpdir(), "vellum-adapter-exec-"));
const pidsPath = join(root, "pids.json");
const markerPath = join(root, "late-spawned");
const workerPath = join(import.meta.dirname, "adapter-exec-worker.ts");

try {
  const leader = await runCli(
    process.execPath,
    [workerPath, "leader-exits-first", pidsPath],
    30_000,
  );
  const leaderPids = JSON.parse(await readFile(pidsPath, "utf8")) as {
    readonly grandchildPid: number;
  };
  await waitUntil(() => !processAlive(leaderPids.grandchildPid));
  await rm(pidsPath, { force: true });

  const pending = runCli(
    process.execPath,
    [workerPath, "parent-ignore-term", pidsPath],
    30_000,
  );
  await waitUntil(() => pathExists(pidsPath));
  const pids = JSON.parse(await readFile(pidsPath, "utf8")) as {
    readonly parentPid: number;
    readonly grandchildPid: number;
  };

  terminateAdapterChildrenOnQuit();
  const pendingResult = await pending;
  await waitUntil(
    () => !processAlive(pids.parentPid) && !processAlive(pids.grandchildPid),
  );

  const lateResult = await runCli(
    process.execPath,
    [workerPath, "marker", markerPath],
    1_000,
  );
  const receipt = {
    leaderResultOk: leader.ok,
    leaderExitedGrandchildAlive: processAlive(leaderPids.grandchildPid),
    pendingOk: pendingResult.ok,
    parentAlive: processAlive(pids.parentPid),
    grandchildAlive: processAlive(pids.grandchildPid),
    lateOk: lateResult.ok,
    lateError: lateResult.error,
    markerCreated: await pathExists(markerPath),
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
