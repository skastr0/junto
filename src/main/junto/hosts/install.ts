import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { cp, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import { MachineInstallError, type MachineBundleManifest, type MachineInstallInput, type MachineInstallResult, type MachineInstallTransition } from "@shared/machine-install";
import { MachineOwnStatus } from "@shared/machine-control";
import { inspectMachineBundle } from "./bundle";
import { checkMachineTree, ensureMachineDirectory, machineHomePath, optionalMetadata, ownedMachineFile } from "./install-paths";
import { machineService } from "./install-service";
import { quiesceMachineService } from "./quiesce-service";
import { acquireInstallLock, admitInstallLockRoot } from "./install-lock";

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const StatusResponse = Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine status"), data: MachineOwnStatus });

export const machineServiceLabel = (installRoot: string, juntoHome: string): string =>
  `dev.junto.machine.${createHash("sha256").update(`${installRoot}\0${juntoHome}`).digest("hex").slice(0,16)}`;

export const readInstalledMachineStatus = async (directory: string, home: string): Promise<MachineOwnStatus> => {
  const result = await exec(join(directory, "bin/junto"), ["machine", "status", "{}"], {
    env: { ...process.env, JUNTO_HOME: home }, timeout: 2_000, maxBuffer: 64 * 1024,
  });
  return Schema.decodeUnknownSync(Schema.fromJsonString(StatusResponse), { onExcessProperty: "error" })(result.stdout.trim()).data;
};

const verifyGeneration = async (path: string, admitted: MachineBundleManifest): Promise<void> => {
  await checkMachineTree(path);
  const installed = await inspectMachineBundle(path);
  if (JSON.stringify(installed) !== JSON.stringify(admitted)) throw new Error("installed bundle differs from the bundle this machine sent");
};

const serviceErrorTail = async (root: string): Promise<string> => {
  const path = join(root, "logs/stderr.log");
  if (!await ownedMachineFile(path)) return "";
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid!()) return "";
    const count = Math.min(metadata.size, 4096), bytes = Buffer.alloc(count);
    await file.read(bytes, 0, count, metadata.size - count);
    return bytes.toString("utf8").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().split("\n").slice(-12).join("\n").slice(-3000);
  } finally { await file.close(); }
};

export const installMachine = (input: MachineInstallInput): Effect.Effect<MachineInstallResult, MachineInstallError> => {
  let disposition: "staged" | "activated" | "uncertain" = "staged";
  const transitions: MachineInstallTransition[] = [];
  return Effect.tryPromise({ try: async () => {
    const juntoHome = await machineHomePath(input.juntoHome ?? homedir(), true);
    const installRoot = await machineHomePath(input.installRoot ?? join(homedir(), ".junto/machine"));
    const manifest = await inspectMachineBundle(input.bundle);
    if (manifest.target !== `${process.platform}-${process.arch}`) throw new Error(`bundle ${manifest.target} does not match this machine`);
    const label = machineServiceLabel(installRoot, juntoHome);
    const record = (transition: MachineInstallTransition): void => {
      transitions.push(transition);
      process.stderr.write(JSON.stringify({ event: "machine-install", juntoHome, installRoot, ...transition }) + "\n");
    };
    await ensureMachineDirectory(installRoot);
    const marker = join(installRoot, "owner.json");
    const expected = JSON.stringify({ serviceLabel: label, juntoHome });
    if (await ownedMachineFile(marker)) {
      if (await readFile(marker, "utf8") !== expected) throw new Error("install directory belongs to another machine home");
    } else {
      if ((await readdir(installRoot)).some(name => name !== ".install-lock")) throw new Error("install directory contains files not owned by this installation");
      try { await writeFile(marker, expected, { mode: 0o600, flag: "wx" }); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || !await ownedMachineFile(marker) || await readFile(marker, "utf8") !== expected) throw error;
      }
    }
    const releaseLock = await acquireInstallLock(await admitInstallLockRoot(installRoot, expected));
    try {
      await ensureMachineDirectory(juntoHome, true);
      await ensureMachineDirectory(join(installRoot, "logs"));
      for (const name of ["stdout.log", "stderr.log"]) await ownedMachineFile(join(installRoot, "logs", name));
      await ensureMachineDirectory(join(installRoot, "builds"));
      const current = join(installRoot, "current");
      const pointer = await optionalMetadata(current);
      let previous: string | undefined;
      if (pointer !== undefined) {
        if (!pointer.isSymbolicLink() || pointer.uid !== process.getuid!()) throw new Error("current must be an owned build selection link");
        previous = await readlink(current);
        if (!/^builds\/[0-9a-f]{64}-(?:darwin-arm64|linux-x64)$/.test(previous)) throw new Error("current selects an invalid build directory");
        await checkMachineTree(join(installRoot, previous));
      }
      const generation = join("builds", manifest.build + "-" + manifest.target);
      const directory = join(installRoot, generation);
      if (await optionalMetadata(directory) === undefined) {
        const stage = join(installRoot, `incoming-${randomUUID()}`);
        try {
          await cp(input.bundle, stage, { recursive: true, dereference: false, errorOnExist: true, force: false });
          await verifyGeneration(stage, manifest);
          await rename(stage, directory);
        } finally { await rm(stage, { recursive: true, force: true }); }
      }
      // Also verifies an idempotent resend and a previously staged generation.
      await verifyGeneration(directory, manifest);
      record({ step: "verified", build: manifest.build });
      const service = await machineService(installRoot, juntoHome, label);
      const before = await service.observe();
      let installationId = input.expectedInstallationId;
      if (before.pid > 0) {
        if (previous === undefined) throw new Error("running service has no admitted build selection");
        const incumbent = await readInstalledMachineStatus(join(installRoot, previous), juntoHome);
        if (incumbent.pid !== before.pid || incumbent.juntoHome !== juntoHome) throw new Error("running core does not match this install");
        if (installationId !== undefined && incumbent.installationId !== installationId) throw new Error("running core installation identity changed");
        installationId = incumbent.installationId;
        if (previous === generation && incumbent.build === manifest.build && incumbent.ready) {
          record({ step: "ready", pid: incumbent.pid });
          return { build: manifest.build, juntoHome, installRoot, directory, serviceLabel: label, provider: service.provider, updated: false, disposition: "ready", installationId, machineName: incumbent.machineName, pid: incumbent.pid, transitions };
        }
      }
      const incumbent = await quiesceMachineService(service, before, () => { disposition = "uncertain"; });
      record({ step: "quiescent", ...(previous === undefined ? {} : { build: previous.split("/")[1]!.slice(0,64) }), ...incumbent });
      const updated = previous !== generation;
      if (updated) {
        const next = join(installRoot, `current-${randomUUID()}`);
        try { await symlink(generation, next); await rename(next, current); }
        finally { await rm(next, { force: true }); }
      }
      // The candidate can open state from here; errors never roll back or retry.
      disposition = "activated";
      record({ step: "selected", build: manifest.build });
      try {
        await service.start();
        record({ step: "started" });
        const deadline = Date.now() + 30_000;
        let detail = "core has not reported ready";
        while (Date.now() < deadline) {
          try {
            const status = await readInstalledMachineStatus(directory, juntoHome);
            const observed = await service.observe();
            if (status.build !== manifest.build || status.juntoHome !== juntoHome || status.pid !== observed.pid) throw new Error("core build, home, or service process does not match the candidate");
            if (installationId !== undefined && status.installationId !== installationId) throw new Error("candidate installation identity changed");
            if (status.ready) {
              record({ step: "ready", pid: status.pid });
              return { build: manifest.build, juntoHome, installRoot, directory, serviceLabel: label, provider: service.provider, updated, disposition: "ready", installationId: status.installationId, machineName: status.machineName, pid: status.pid, transitions };
            }
          } catch (cause) { detail = cause instanceof Error ? cause.message : String(cause); }
          await sleep(200);
        }
        throw new Error(detail);
      } catch (cause) {
        disposition = "uncertain";
        let diagnostics = "";
        try { diagnostics = await serviceErrorTail(installRoot); } catch { /* Cleanup still runs if diagnostics cannot be read. */ }
        try {
          await quiesceMachineService(service, await service.observe(), () => {});
          await service.removeDefinition();
        } catch (stopCause) {
          throw new Error(`Junto did not start, and stopping it could not be confirmed. Check this machine before sending again. ${(stopCause instanceof Error ? stopCause.message : String(stopCause)).slice(0, 800)}${diagnostics ? "\n" + diagnostics : ""}`);
        }
        disposition = "activated";
        throw new Error(`Junto is installed but did not start. Nothing is running there. Send a fixed build to recover.\n${diagnostics || (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000)}`);
      }
    } finally { await releaseLock(); }
  }, catch: cause => new MachineInstallError({ message: cause instanceof Error ? cause.message : String(cause), retryable: disposition === "staged", disposition, transitions }) });
};
