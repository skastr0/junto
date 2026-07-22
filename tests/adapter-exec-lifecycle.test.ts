import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface LifecycleReceipt {
  readonly leaderResultOk: boolean;
  readonly leaderExitedGrandchildAlive: boolean;
  readonly pendingOk: boolean;
  readonly parentAlive: boolean;
  readonly grandchildAlive: boolean;
  readonly lateOk: boolean;
  readonly lateError?: string;
  readonly markerCreated: boolean;
}

const runLifecycleFixture = async (): Promise<LifecycleReceipt> => {
  const fixture = join(
    import.meta.dirname,
    "fixtures",
    "adapter-exec-lifecycle-child.ts",
  );
  // This fixture imports the TypeScript adapter directly. Vitest itself runs
  // under Node, so use Bun explicitly instead of inheriting process.execPath.
  const child = spawn("bun", [fixture], {
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
      }, 10_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve({ code, forced });
      });
    },
  );

  expect({ ...exit, stderr }).toEqual({ code: 0, forced: false, stderr: "" });
  return JSON.parse(stdout.trim()) as LifecycleReceipt;
};

describe.skipIf(process.platform === "win32")("adapter execution lifecycle", () => {
  it("terminates an owned parent and grandchild and rejects every late spawn", async () => {
    await expect(runLifecycleFixture()).resolves.toEqual({
      leaderResultOk: true,
      leaderExitedGrandchildAlive: false,
      pendingOk: false,
      parentAlive: false,
      grandchildAlive: false,
      lateOk: false,
      lateError: "adapter process plane is shutting down",
      markerCreated: false,
    });
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
