import { readSingleProcessEpochSnapshot } from "../process-epoch";
import type { MachineService } from "./install-service";

/** Stop by service identity, then independently observe the captured epoch gone. */
export const quiesceMachineService = async (
  service: MachineService,
  before: { loaded: boolean; pid: number },
  onStopping: () => void,
): Promise<{ pid?: number; startKey?: string; service: "absent" | "unloaded" | "inactive" }> => {
  if (!before.loaded) {
    if (before.pid !== 0) throw new Error("absent service reported a running process");
    return { service: "absent" };
  }
  const epoch = before.pid > 0 ? readSingleProcessEpochSnapshot(before.pid)?.[0] : undefined;
  if (before.pid > 0 && epoch === undefined) throw new Error("cannot establish the incumbent process identity");
  onStopping();
  await service.stop();
  const deadline = Date.now() + 30_000;
  while (epoch !== undefined) {
    const rows = readSingleProcessEpochSnapshot(epoch.pid);
    if (rows !== undefined && !rows.some(row => row.startKey === epoch.startKey)) break;
    if (Date.now() >= deadline) throw new Error("incumbent process exit is unconfirmed; inspect machine status before recovering forward");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const stopped = await service.observe();
  if (stopped.pid !== 0 || (service.provider === "launchd" && stopped.loaded)) throw new Error("service did not become quiescent");
  return { ...(epoch === undefined ? {} : { pid: epoch.pid, startKey: epoch.startKey }), service: service.provider === "launchd" ? "unloaded" : "inactive" };
};
