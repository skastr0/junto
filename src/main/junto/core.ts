import { Effect } from "effect";
import { join } from "node:path";
import type { MachineCoreOptions } from "../core-runtime";
import { makeCoreRuntime } from "../core-runtime";
import { MachineCoreStatus } from "../core-runtime";
import { MachineOwnerControl } from "./hosts/machine-owner";
import { MachineLink, type MachineLinkListener } from "./link/service";
import { startOperatorControlServer, type OperatorControlServer } from "./operator-control";
import { evaluateSchemaCompatibility, probeInstalledStateSchema } from "./state/schema-version-probe";
import { configurePeerPidHelperRoots } from "./process-identity";
import { quiesceServiceChildrenOnQuit } from "../services/process";

export interface CoreOptions extends Omit<MachineCoreOptions, "ready"> {
  readonly peerPidHelperRoots: ReadonlyArray<string>;
}

/** Both shells use this owner/link lifecycle; it creates no canvas. */
export const startCore = async (options: CoreOptions) => {
  configurePeerPidHelperRoots(options.peerPidHelperRoots);
  const schema = evaluateSchemaCompatibility(probeInstalledStateSchema(join(options.home, ".junto", "state", "junto.db")));
  if (!schema.ok) throw new Error(`Update Junto: this database uses schema ${schema.userVersion}, this build supports ${schema.supportedVersion}`);
  let admitted = false;
  let stopping = false;
  let owner: OperatorControlServer | undefined;
  let listener: MachineLinkListener | undefined;
  const runtime = makeCoreRuntime({ ...options, ready: () => admitted && !stopping && owner?.ready() === true && listener?.ready() === true });
  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    stopping = true;
    admitted = false;
    owner?.beginShutdown();
    listener?.beginShutdown();
    closeFlight = (async () => {
      if (owner !== undefined) {
        const receipt = await owner.close();
        if (!receipt.clean) throw new Error("Owner commands did not drain; core state retained");
      }
      if (listener !== undefined) await listener.close();
      await runtime.dispose();
      const children = await quiesceServiceChildrenOnQuit();
      if (!children.clean) throw new Error("Core service children did not drain");
    })();
    return closeFlight;
  };
  try {
    const [actions, link, status] = await runtime.runPromise(Effect.all([MachineOwnerControl, MachineLink, MachineCoreStatus]));
    await runtime.runPromise(link.setChannels({ status: status.handler }));
    listener = await runtime.runPromise(link.listen(options.home));
    owner = await startOperatorControlServer({ home: options.home, dispatch: (request) => runtime.runPromise(actions.dispatch(request)) });
    admitted = true;
    return { runtime, close, ready: () => admitted && !stopping && owner!.ready() && listener!.ready() };
  } catch (cause) {
    await close();
    throw cause;
  }
};
