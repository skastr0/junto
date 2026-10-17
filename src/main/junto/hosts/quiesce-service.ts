import { Schema } from "effect";
import { readSingleProcessEpochSnapshot } from "../process-epoch";
import type { MachineService } from "./install-service";

/** Which stop check could not prove the service quiescent. */
export class MachineServiceNotQuiescent extends Schema.TaggedError<MachineServiceNotQuiescent>()("MachineServiceNotQuiescent", {
  check: Schema.Literals(["absent-running", "identity-unknown", "exit-unconfirmed", "still-running"]),
  message: Schema.String,
}) {}

/** Stop by service identity, then independently observe the captured epoch gone. */
export const quiesceMachineService = async (
  service: Pick<MachineService, "provider" | "observe" | "stop">,
  before: { loaded: boolean; pid: number },
  onStopping: () => void,
): Promise<{ pid?: number; startKey?: string; service: "absent" | "unloaded" | "inactive" }> => {
  if (!before.loaded) {
    if (before.pid !== 0) throw new MachineServiceNotQuiescent({ check: "absent-running", message: "absent service reported a running process" });
    return { service: "absent" };
  }
  const epoch = before.pid > 0 ? readSingleProcessEpochSnapshot(before.pid)?.[0] : undefined;
  if (before.pid > 0 && epoch === undefined) throw new MachineServiceNotQuiescent({ check: "identity-unknown", message: "cannot establish the incumbent process identity" });
  onStopping();
  await service.stop();
  const deadline = Date.now() + 30_000;
  while (epoch !== undefined) {
    const rows = readSingleProcessEpochSnapshot(epoch.pid);
    if (rows !== undefined && !rows.some(row => row.startKey === epoch.startKey)) break;
    if (Date.now() >= deadline) throw new MachineServiceNotQuiescent({ check: "exit-unconfirmed", message: "incumbent process exit is unconfirmed; inspect machine status before recovering forward" });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const stopped = await service.observe();
  if (stopped.pid !== 0 || (service.provider === "launchd" && stopped.loaded)) throw new MachineServiceNotQuiescent({ check: "still-running", message: "service did not become quiescent" });
  return { ...(epoch === undefined ? {} : { pid: epoch.pid, startKey: epoch.startKey }), service: service.provider === "launchd" ? "unloaded" : "inactive" };
};
