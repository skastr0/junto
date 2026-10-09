import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { MachineOwnStatus } from "../src/shared/machine-control";
import { spawnServiceChild } from "../src/main/services/process";

const exec = promisify(execFile);
const Status = Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine status"), data: MachineOwnStatus });

/** The build is usable only after the relocated payload reports ready and quits cleanly. */
export const bootRelocatedMachineBundle = async (bundle: string, build: string): Promise<void> => {
  // Unix control sockets cannot fit under macOS's long per-user TMPDIR.
  const scratch = await mkdtemp("/tmp/jb-");
  const relocated = join(scratch, "package"), home = join(scratch, "home");
  await cp(bundle, relocated, { recursive: true, dereference: false });
  await mkdir(home, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("JUNTO_") && !["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(name)) environment[name] = value;
  }
  environment.JUNTO_HOME = home;
  const core = spawnServiceChild({ source: "machine.bundle-boot", purpose: "relocated bundle build check",
    command: join(relocated, "bin/node"), args: [join(relocated, "core/junto.cjs")], cwd: relocated, env: environment });
  let stderr = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    core.io.stdout.resume();
    core.io.stderr.on("data", bytes => {
      stderr = (stderr + String(bytes)).slice(-4096);
      if (stderr.split("\n").includes("Junto core is ready")) resolve();
    });
    core.io.onError(reject);
    void core.io.closed.then(() => reject(new Error("Relocated Junto core exited before ready: " + stderr.trim())));
    timer = setTimeout(() => reject(new Error("Relocated Junto core did not report ready: " + stderr.trim())), 30_000);
  });
  try {
    await ready;
    clearTimeout(timer);
    const result = await exec(join(relocated, "bin/junto"), ["machine", "status", "{}"], { env: environment, cwd: relocated, timeout: 5_000, maxBuffer: 64 * 1024 });
    const status = Schema.decodeUnknownSync(Schema.fromJsonString(Status), { onExcessProperty: "error" })(result.stdout.trim()).data;
    if (!status.ready || status.build !== build || status.juntoHome !== home) throw new Error("Relocated Junto core did not prove its build and isolated home");
    process.stderr.write(JSON.stringify({ event: "machine-bundle-boot", build, ready: true, relocated: true }) + "\n");
  } finally {
    clearTimeout(timer);
    const stopped = await core.terminateAndWaitForClose();
    if (!stopped) throw new Error(`Relocated Junto core did not stop; check retained test home ${home}`);
    const exit = await core.io.closed;
    await rm(scratch, { recursive: true, force: true });
    if (exit.code !== 0 || exit.signal !== null) throw new Error("Relocated Junto core did not quit cleanly: " + stderr.trim());
  }
};
