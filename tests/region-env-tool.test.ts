/**
 * The one bounded call every external store goes through, against real
 * processes that are safe to run anywhere: the test's own runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToolRunner, type ToolRunner } from "../src/main/junto/region-env/tool";
import { createAppProcessPlane, type AppProcessPlane } from "../src/main/junto/app-process-plane";

const node = process.execPath;
let plane: AppProcessPlane;
let runTool: ToolRunner;
beforeEach(() => {
  plane = createAppProcessPlane();
  runTool = makeToolRunner(plane);
});
afterEach(async () => {
  expect((await plane.drainOnQuit()).clean).toBe(true);
});

describe("runTool", () => {
  it("app shutdown stops an in-flight environment tool and refuses new spawns", async () => {
    const pending = runTool({ command: node, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 5000 });
    expect((await plane.drainOnQuit()).clean).toBe(true);
    expect(await pending).toEqual({ kind: "failed" });
    expect(await runTool({ command: node, args: ["-e", "process.exit(0)"], timeoutMs: 5000 })).toEqual({ kind: "failed" });
  });

  it("bounds each output stream without returning its contents", async () => {
    expect(await runTool({ command: node, args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], timeoutMs: 5000 })).toEqual({ kind: "failed" });
  });
  it("returns stdout on success", async () => {
    expect(await runTool({ command: node, args: ["-e", "process.stdout.write('value')"], timeoutMs: 5000 })).toEqual({
      kind: "ok",
      stdout: "value",
    });
  });

  it("reports an exit code with what the tool said", async () => {
    expect(
      await runTool({ command: node, args: ["-e", "console.error('nope'); process.exit(44)"], timeoutMs: 5000 }),
    ).toEqual({ kind: "exit", code: 44, stdout: "", stderr: "nope\n" });
  });

  it("a tool that is not installed is not an exception", async () => {
    expect(await runTool({ command: "/nonexistent/junto-no-such-tool", args: [], timeoutMs: 5000 })).toEqual({
      kind: "not-installed",
    });
  });

  it("kills a tool that outlives its timeout and says so", async () => {
    const started = Date.now();
    const out = await runTool({ command: node, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 300 });
    expect(out).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a timed-out command cannot leave a credential-bearing subprocess running", async () => {
    const folder = mkdtempSync(join(tmpdir(), "junto-env-tool-child-"));
    const marker = join(folder, "still-running");
    const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'canary'), 800)`;
    const program = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' });`,
      "setTimeout(() => {}, 60000);",
    ].join("\n");
    try {
      expect(await runTool({ command: node, args: ["-e", program], timeoutMs: 300 })).toEqual({ kind: "timeout" });
      // The child exits on its own after writing, even when the old runner
      // leaves it behind. Only a disposable marker is observed, no signals.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 10_000);

  it("gives the process exactly the environment it was handed", async () => {
    const out = await runTool({
      command: node,
      args: ["-e", "process.stdout.write(String(process.env.ONLY_HERE) + '|' + String(process.env.HOME))"],
      timeoutMs: 5000,
      env: { ONLY_HERE: "yes", PATH: process.env.PATH },
    });
    expect(out).toEqual({ kind: "ok", stdout: "yes|undefined" });
    expect(process.env.ONLY_HERE).toBeUndefined();
  });

  it("a tool that waits on stdin sees end of input instead of hanging", async () => {
    const out = await runTool({
      command: node,
      args: ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.stdout.write('eof'))"],
      timeoutMs: 5000,
    });
    expect(out).toEqual({ kind: "ok", stdout: "eof" });
  });
});
