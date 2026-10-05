/**
 * The one bounded call every external store goes through, against real
 * processes that are safe to run anywhere: the test's own runtime.
 */
import { describe, expect, it } from "vitest";
import { runTool } from "../src/main/junto/region-env/tool";

const node = process.execPath;

describe("runTool", () => {
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
