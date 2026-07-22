import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface LifecycleReceipt {
  readonly gracefulOk: boolean;
  readonly gracefulSettledWithinBound: boolean;
  readonly failedSpawnOk: boolean;
  readonly drainClean: boolean;
  readonly drainRetained: number;
  readonly drainScope: string;
  readonly drainOwnershipUnverified: number;
  readonly repeatedQuitCoalesced: boolean;
  readonly inheritedResultOk: boolean;
  readonly inheritedError?: string;
  readonly inheritedGrandchildAliveWhenSettled: boolean;
  readonly inheritedAliveAtFirstDrain: boolean;
  readonly closedResultOk: boolean;
  readonly closedGrandchildAliveWhenSettled: boolean;
  readonly closedAliveAtFirstDrain: boolean;
  readonly pendingOk: boolean;
  readonly parentAlive: boolean;
  readonly activeGrandchildAlive: boolean;
  readonly activeGroupReapedBeforeHardExpiry: boolean;
  readonly convergedDrainClean: boolean;
  readonly convergedDrainRetained: number;
  readonly convergedDrainScope: string;
  readonly lateOk: boolean;
  readonly lateError?: string;
  readonly markerCreated: boolean;
}

interface OwnershipUnverifiedReceipt {
  readonly resultOk: boolean;
  readonly snapshotCalls: number;
  readonly drainClean: boolean;
  readonly drainRetained: number;
  readonly drainScope: string;
  readonly ownershipUnverified: number;
  readonly signalAuditEntries: number;
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
  it("observes stdio-closed and inherited-pipe original groups until natural exit", async () => {
    const receipt = await runLifecycleFixture<LifecycleReceipt>();
    expect(receipt).toMatchObject({
      gracefulOk: true,
      gracefulSettledWithinBound: true,
      failedSpawnOk: false,
      drainClean: false,
      drainScope: "original-process-group",
      drainOwnershipUnverified: 0,
      repeatedQuitCoalesced: true,
      inheritedResultOk: false,
      inheritedError:
        "adapter command leader exited while output streams remained open; original process group retained for read-only observation",
      inheritedGrandchildAliveWhenSettled: true,
      inheritedAliveAtFirstDrain: true,
      closedResultOk: true,
      closedGrandchildAliveWhenSettled: true,
      closedAliveAtFirstDrain: true,
      pendingOk: false,
      parentAlive: false,
      activeGrandchildAlive: false,
      activeGroupReapedBeforeHardExpiry: true,
      convergedDrainClean: true,
      convergedDrainRetained: 0,
      convergedDrainScope: "original-process-group",
      lateOk: false,
      lateError: "adapter process plane is shutting down",
      markerCreated: false,
    });
    expect(receipt.drainRetained).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("keeps a failed second admission snapshot explicitly unverified and non-signalable", async () => {
    const receipt = await runLifecycleFixture<OwnershipUnverifiedReceipt>(
      "ownership-unverified",
    );
    expect(receipt).toMatchObject({
      resultOk: true,
      snapshotCalls: 2,
      drainClean: false,
      drainScope: "original-process-group",
      ownershipUnverified: 1,
      signalAuditEntries: 0,
    });
    expect(receipt.drainRetained).toBeGreaterThanOrEqual(1);
  });

  it("routes normal quit and direct app.exit paths through adapter quiescence", () => {
    const indexSource = readFileSync(
      join(import.meta.dirname, "..", "src/main/index.ts"),
      "utf8",
    );
    const detachStart = indexSource.indexOf("const detachRuntimeOnQuit");
    const detachEnd = indexSource.indexOf("const exitAfterDetach", detachStart);
    const detachBlock = indexSource.slice(detachStart, detachEnd);

    expect(detachBlock.indexOf("terminateAdapterChildrenOnQuit()"))
      .toBeGreaterThanOrEqual(0);
    expect(detachBlock.indexOf("terminateAdapterChildrenOnQuit()"))
      .toBeLessThan(detachBlock.indexOf("browserComposition?.close()"));
    expect(indexSource).toMatch(
      /app\.on\("before-quit",[\s\S]*detachRuntimeOnQuit\("before-quit"\)/u,
    );
    const executableIndexSource = indexSource
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    expect(executableIndexSource.match(/app\.exit\(/gu)).toHaveLength(1);
    expect(indexSource).toMatch(/exitAfterDetach[\s\S]*app\.exit\(exitCode\)/u);
  });
});
