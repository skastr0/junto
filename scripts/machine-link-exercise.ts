/** Milestone A uses packaged owner commands; no exercise-defined wire protocol. */
import { execFile, spawn } from "node:child_process";
import { open, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { MachineConfigured, MachineOwnStatus, MachinePeerStatus, type MachineAddInput } from "../src/shared/machine-control";
import { MachineInstallResult } from "../src/shared/machine-install";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const requireProof = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

export function assertLinkedStatus(own: MachineOwnStatus, installed: MachineInstallResult, peer: MachinePeerStatus) {
  requireProof(own.ready && own.build === installed.build, "link endpoints are not ready on the same build");
  requireProof(own.machineName !== installed.machineName && own.installationId !== installed.installationId,
    "link evidence does not identify two distinct machines");
  requireProof(peer.reachable && peer.machineName === installed.machineName && peer.installationId === installed.installationId,
    "linked status does not identify the installed peer");
  requireProof(peer.form !== undefined, "linked status lacks the peer machine form");
}

export async function exerciseMachineLink(input: {
  bundle: string;
  remoteBundle: string;
  receipts: string;
  localName: string;
  remote: MachineAddInput;
  record: (step: string, value: unknown) => Promise<void>;
}): Promise<MachineInstallResult> {
  const home = join(input.receipts, "local-home");
  await mkdir(home, { mode: 0o700 }); // Never reuse a home from a failed run.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("JUNTO_") && !["INVOCATION_ID", "ELECTRON_RUN_AS_NODE", "NODE_PATH"].includes(key)));
  env.JUNTO_HOME = home;
  const log = await open(join(input.receipts, "local-core.log"), "wx", 0o600);
  const child = spawn(join(input.bundle, "bin/node"), [join(input.bundle, "core/junto.cjs")], {
    env, stdio: ["ignore", log.fd, log.fd],
  });
  let ended = false;
  const completion = new Promise<{ code: number | null; signal: string | null; error?: string }>(resolve => {
    child.once("error", error => { ended = true; resolve({ code: null, signal: null, error: error.message }); });
    child.once("exit", (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  const command = async (op: string, args: unknown): Promise<unknown> => {
    const result = await exec(join(input.bundle, "bin/junto"), ["machine", op, JSON.stringify(args)], {
      env, timeout: op === "send" ? 16 * 60_000 : 30_000, maxBuffer: 1024 * 1024,
    });
    const envelope = JSON.parse(result.stdout);
    requireProof(envelope.ok === true && envelope.command === `machine ${op}`, `machine ${op} did not succeed`);
    await input.record(`owner.${op}`, envelope);
    return envelope.data;
  };
  try {
    const socket = join(home, ".junto/operator/control.sock");
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ended && Date.now() < deadline) {
      ready = await stat(socket).then(value => value.isSocket(), () => false);
      if (ready) break;
      await delay(50);
    }
    requireProof(ready && !ended, "local core did not expose its owner socket within 30 seconds");
    const configured = Schema.decodeUnknownSync(MachineConfigured)(await command("configure", { name: input.localName }));
    requireProof(configured.machineName === input.localName, "local core did not keep its exercise name");
    const own = Schema.decodeUnknownSync(MachineOwnStatus)(await command("status", {}));
    requireProof(own.pid === child.pid && own.juntoHome === home && own.machineName === configured.machineName &&
      own.installationId === configured.installationId, "local status does not identify the owned core");
    await input.record("localStatus", own);
    await command("add", input.remote);
    const installed = Schema.decodeUnknownSync(MachineInstallResult)(await command("send", {
      name: input.remote.name, bundle: input.remoteBundle,
    }));
    const peer = Schema.decodeUnknownSync(MachinePeerStatus)(await command("status", { name: input.remote.name }));
    assertLinkedStatus(own, installed, peer);
    await input.record("linkedStatus", { own, peer, installed });
    return installed;
  } catch (cause) {
    await input.record("linkFailure", cause instanceof Error ? cause.message : String(cause));
    throw cause;
  } finally {
    let forced = false;
    if (!ended) child.kill("SIGTERM"); // Owned ChildProcess handle, never a discovered PID.
    let stopped = await Promise.race([completion, delay(10_000).then(() => undefined)]);
    if (stopped === undefined) {
      forced = true;
      child.kill("SIGKILL");
      stopped = await Promise.race([completion, delay(3000).then(() => undefined)]);
    }
    await log.close();
    await input.record("localShutdown", { ...stopped, forced, reaped: stopped !== undefined });
    requireProof(stopped?.code === 0 && !forced, "local core did not shut down cleanly; remote root preserved");
  }
}
