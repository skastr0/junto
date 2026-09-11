import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface LifecycleReceipt {
  readonly gracefulOk: boolean;
  readonly gracefulSettledWithinBound: boolean;
  readonly failedSpawnOk: boolean;
  readonly adapterDrainSettled: boolean;
  readonly adapterDrainPending: number;
  readonly adapterDrainScope: string;
  readonly repeatedQuitCoalesced: boolean;
  readonly inheritedResultOk: boolean;
  readonly inheritedError?: string;
  readonly inheritedGrandchildAliveWhenSettled: boolean;
  readonly inheritedAliveAtAdapterDrain: boolean;
  readonly inheritedAliveAtAppDrain: boolean;
  readonly closedResultOk: boolean;
  readonly closedGrandchildAliveWhenSettled: boolean;
  readonly closedAliveAtAdapterDrain: boolean;
  readonly closedAliveAtAppDrain: boolean;
  readonly pendingOk: boolean;
  readonly pendingError?: string;
  readonly parentAlive: boolean;
  readonly activeGrandchildAlive: boolean;
  readonly activeGroupReapedBeforeHardExpiry: boolean;
  readonly appDrainClean: boolean;
  readonly appDrainStragglerStates: readonly string[];
  readonly adapterRetrySettled: boolean;
  readonly adapterRetryPending: number;
  readonly adapterRetryScope: string;
  readonly appConvergedDrainClean: boolean;
  readonly appConvergedStragglers: number;
  readonly lateOk: boolean;
  readonly lateError?: string;
  readonly markerCreated: boolean;
}

interface OwnershipUnverifiedReceipt {
  readonly resultOk: boolean;
  readonly snapshotCalls: number;
  readonly adapterDrainSettled: boolean;
  readonly adapterDrainPending: number;
  readonly adapterDrainScope: string;
  readonly appDrainClean: boolean;
  readonly appDrainStragglerStates: readonly string[];
}

const runLifecycleFixture = async <Receipt>(
  scenario?: string,
): Promise<Receipt> => {
  const fixture = join(
    import.meta.dirname,
    "fixtures",
    "adapter-exec-lifecycle-child.ts",
  );
  // This fixture imports the TypeScript adapter directly. Vitest itself runs
  // under Node, so use Bun explicitly instead of inheriting process.execPath.
  const child = spawn("bun", scenario === undefined ? [fixture] : [fixture, scenario], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = await new Promise<{ readonly code: number | null; readonly forced: boolean }>(
    (resolve, reject) => {
      let forced = false;
      const timeout = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 12_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve({ code, forced });
      });
    },
  );

  expect({ ...exit, stderr }).toEqual({ code: 0, forced: false, stderr: "" });
  return JSON.parse(stdout.trim()) as Receipt;
};

describe.skipIf(process.platform === "win32")("adapter execution lifecycle", () => {
  it("settles adapter operations while the central plane retains OS group truth", async () => {
    const receipt = await runLifecycleFixture<LifecycleReceipt>();
    expect(receipt).toMatchObject({
      gracefulOk: true,
      gracefulSettledWithinBound: true,
      failedSpawnOk: false,
      adapterDrainSettled: true,
      adapterDrainPending: 0,
      adapterDrainScope: "adapter-operations",
      repeatedQuitCoalesced: true,
      inheritedResultOk: false,
      inheritedError:
        "adapter command leader exited while output streams remained open; adapter operation stopped waiting for stream closure",
      inheritedGrandchildAliveWhenSettled: true,
      inheritedAliveAtAdapterDrain: true,
      inheritedAliveAtAppDrain: true,
      closedResultOk: true,
      closedGrandchildAliveWhenSettled: true,
      closedAliveAtAdapterDrain: true,
      closedAliveAtAppDrain: true,
      pendingOk: false,
      pendingError: "adapter process plane is shutting down",
      parentAlive: false,
      activeGrandchildAlive: false,
      activeGroupReapedBeforeHardExpiry: true,
      appDrainClean: false,
      adapterRetrySettled: true,
      adapterRetryPending: 0,
      adapterRetryScope: "adapter-operations",
      appConvergedDrainClean: true,
      appConvergedStragglers: 0,
      lateOk: false,
      lateError: "adapter process plane is shutting down",
      markerCreated: false,
    });
    expect(receipt.appDrainStragglerStates.filter(
      (state) => state === "leaderless-group"
    ).length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("leaves failed group ownership observation solely in the central receipt", async () => {
    const receipt = await runLifecycleFixture<OwnershipUnverifiedReceipt>(
      "ownership-unverified",
    );
    expect(receipt).toMatchObject({
      resultOk: true,
      adapterDrainSettled: true,
      adapterDrainPending: 0,
      adapterDrainScope: "adapter-operations",
      appDrainClean: false,
    });
    expect(receipt.snapshotCalls).toBeGreaterThanOrEqual(2);
    expect(receipt.appDrainStragglerStates).toContain("ownership-unverified");
  });

  it("delegates group spawn and all OS lifecycle authority to appProcessPlane", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src/main/vellum-command/adapters/exec.ts"),
      "utf8",
    );
    expect(source).toContain("appProcessPlane.spawnGroup({");
    expect(source).toContain("appProcessPlane.terminate(");
    expect(source).toContain("appProcessPlane.forceTerminate(");
    expect(source).not.toMatch(/process-signal|process-epoch/u);
    expect(source).not.toMatch(
      /spawnDetachedProcessGroup|signalOwned|releaseOwned|OwnedProcess/u,
    );
    expect(source).not.toMatch(/original-process-group|process-tree.*clean/iu);
  });

  it("routes normal quit and direct app.exit paths through adapter quiescence", () => {
    const indexSource = readFileSync(
      join(import.meta.dirname, "..", "src/main/index.ts"),
      "utf8",
    );
    const admissionStart = indexSource.indexOf("const beginShutdownAdmission");
    const admissionEnd = indexSource.indexOf("const logUnfinishedDrain", admissionStart);
    const admissionBlock = indexSource.slice(admissionStart, admissionEnd);

    expect(admissionBlock.indexOf("terminateAdapterChildrenOnQuit()"))
      .toBeGreaterThanOrEqual(0);
    expect(admissionBlock.indexOf("terminateAdapterChildrenOnQuit()"))
      .toBeLessThan(admissionBlock.indexOf("appProcessPlane.beginShutdown()"));
    expect(indexSource).toMatch(
      /app\.on\("before-quit",[\s\S]*detachRuntimeOnQuit\("before-quit"\)/u,
    );
    const executableIndexSource = indexSource
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    const updateHooksStart = executableIndexSource.indexOf("installUpdateHostHooks({");
    const updateHooksEnd = executableIndexSource.indexOf("\n    });", updateHooksStart);
    const updateHooks = executableIndexSource.slice(updateHooksStart, updateHooksEnd);
    expect(updateHooks).toMatch(
      /quiesceForInstall: async \(\) => \{\s*await flushCanvasOnQuit\(\);\s*detachRuntimeOnQuit\("update-install"\);\s*await disposeRuntimeFailClosed\("update-install"\);\s*runtimeDisposed = true;\s*skipQuitConfirm = true;/u,
    );
    const installedHandoff = updateHooks.slice(updateHooks.indexOf("relaunchInstalled:"));
    expect(installedHandoff).toMatch(
      /relaunchInstalled: \(executablePath\) => \{\s*skipQuitConfirm = true;\s*runtimeDisposed = true;\s*app\.relaunch\(\{ execPath: executablePath, args: \[\] \}\);\s*app\.exit\(0\);/u,
    );
    const linuxUpdateSource = readFileSync(
      join(import.meta.dirname, "..", "src/main/vellum-command/update/linux.ts"),
      "utf8",
    );
    expect(linuxUpdateSource).toMatch(
      /installAfterQuiesce:[\s\S]*await revalidate\(\);[\s\S]*await activateLinuxDesktopRelease\(staged,[\s\S]*expectedIncumbentExecutablePath: process\.execPath[\s\S]*host\.relaunchInstalled\(staged\.executablePath\);/u,
    );
    // Exhaustive direct exits: detached normal exit, pre-activation recovery,
    // and the admitted installed generation handoff checked above.
    expect(executableIndexSource.match(/app\.exit\(/gu)).toHaveLength(3);
    expect(indexSource).toMatch(/exitAfterDetach[\s\S]*app\.exit\(exitCode\)/u);
  });
});
