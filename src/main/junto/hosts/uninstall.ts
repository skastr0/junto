import { mkdir, readFile, readlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { MachineInstallError, type MachineInstallTransition, type MachineLocalPaths, type MachineUninstallResult } from "@shared/machine-install";
import { machineServiceLabel, readInstalledMachineStatus } from "./install";
import { checkMachineTree, machineHomePath, optionalMetadata, ownedMachineFile } from "./install-paths";
import { machineService } from "./install-service";
import { quiesceMachineService } from "./quiesce-service";

/** Retains package and product bytes; removes only the proven owned service. */
export const uninstallMachine = (input: MachineLocalPaths): Effect.Effect<MachineUninstallResult, MachineInstallError> => {
  let disposition: "staged" | "uncertain" = "staged";
  const transitions: MachineInstallTransition[] = [];
  return Effect.tryPromise({ try: async () => {
    const juntoHome = await machineHomePath(input.juntoHome ?? homedir(), true);
    const installRoot = await machineHomePath(input.installRoot ?? join(homedir(), ".junto/machine"));
    const label = machineServiceLabel(installRoot, juntoHome);
    const marker = join(installRoot, "owner.json");
    if (!await ownedMachineFile(marker) || await readFile(marker, "utf8") !== JSON.stringify({ serviceLabel: label, juntoHome })) throw new Error("install directory ownership is not established");
    const lock = join(installRoot, ".install-lock");
    await mkdir(lock, { mode: 0o700 });
    try {
      const pointer = await optionalMetadata(join(installRoot, "current"));
      if (!pointer?.isSymbolicLink() || pointer.uid !== process.getuid!()) throw new Error("current must be an owned build selection link");
      const generation = await readlink(join(installRoot, "current"));
      if (!/^builds\/[0-9a-f]{64}-(?:darwin-arm64|linux-x64)$/.test(generation)) throw new Error("current selects an invalid build directory");
      await checkMachineTree(join(installRoot, generation));
      const service = await machineService(installRoot, juntoHome, label);
      const before = await service.observe();
      if (before.pid > 0) {
        const core = await readInstalledMachineStatus(join(installRoot, generation), juntoHome);
        if (core.pid !== before.pid || core.juntoHome !== juntoHome) throw new Error("running core does not match this install");
      }
      const incumbent = await quiesceMachineService(service, before, () => { disposition = "uncertain"; });
      transitions.push({ step: "quiescent", build: generation.split("/")[1]!.slice(0,64), ...incumbent });
      disposition = "uncertain";
      await service.removeDefinition();
      return { juntoHome, installRoot, serviceLabel: label, disposition: "stopped", definitionRemoved: true, transitions };
    } finally { await rm(lock, { recursive: true, force: true }); }
  }, catch: cause => new MachineInstallError({ message: cause instanceof Error ? cause.message : String(cause), disposition, retryable: disposition === "staged", transitions }) });
};
