import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import * as Command from "effect/unstable/process/ChildProcess";
import { expect, it } from "vitest";
import { parseSshRoute } from "../src/main/junto/ssh";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import { machinePreflight } from "../src/main/junto/ssh/machine-preflight";

it("runs the closed preflight and aggregates wrong architecture, low space and an invalid folder", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "junto-preflight-")));
  try {
    const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target" }));
    const program = await Effect.runPromise(machinePreflight(target, {
      target: process.platform === "darwin" ? "linux-x64" : "darwin-arm64",
      requiredKiB: Number.MAX_SAFE_INTEGER,
      juntoHome: home,
      installRoot: "/outside-account/install",
    }));
    const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-preflight-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
    const command = compiler.oneShot(program).command;
    if (!Command.isStandardCommand(command)) throw new Error("expected argv command");
    const output = execFileSync("/bin/sh", ["-c", command.args.at(-1)!], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(output).toContain("This package is for");
    expect(output).toContain("Free at least");
    expect(output).toContain("under the SSH account home");
    expect(output).toContain("Fix these problems, then send again");
    expect(existsSync(join(home, ".junto"))).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("rejects unbounded or relative selections before compiling an SSH command", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target" }));
  await expect(Effect.runPromise(machinePreflight(target, { target: "linux-x64", requiredKiB: Infinity }))).rejects.toThrow("Invalid machine preflight");
  await expect(Effect.runPromise(machinePreflight(target, { target: "linux-x64", requiredKiB: 1, installRoot: "relative" }))).rejects.toThrow("Invalid machine preflight");
});
