import { Context, Effect } from "effect";
import { join } from "node:path";
import type { MachineCoreOptions } from "../core-runtime";
import { makeCoreRuntime } from "../core-runtime";
import { MachineCoreStatus, MachineCoreRows, MachineCoreSeats, MachineCoreMail } from "../core-runtime";
import { MachineOwnerControl } from "./hosts/machine-owner";
import { MachineLink, type MachineLinkListener } from "./link/service";
import { startOperatorControlServer, type OperatorControlServer } from "./operator-control";
import { evaluateSchemaCompatibility, probeInstalledStateSchema } from "./state/schema-version-probe";
import { quiesceServiceChildrenOnQuit } from "../services/process";
import { installCoreRunner } from "../core-runner";
import { startWorkControlServer, type WorkControlServer } from "./work/control";
import { workControlDir } from "@shared/work-control";
import { startCoreSeats } from "./term/core-seats";
import { mainAuthoringGate } from "./main-authoring-gate";

export type CoreOptions = Omit<MachineCoreOptions, "ready">;

/** Both shells use this owner/link lifecycle; it creates no canvas. */
export const startCore = async (options: CoreOptions) => {
  const schema = evaluateSchemaCompatibility(probeInstalledStateSchema(join(options.home, ".junto", "state", "junto.db")));
  if (!schema.ok) throw new Error(`Update Junto: this database uses schema ${schema.userVersion}, this build supports ${schema.supportedVersion}`);
  let admitted = false;
  let stopping = false;
  let owner: OperatorControlServer | undefined;
  let listener: MachineLinkListener | undefined;
  let work: WorkControlServer | undefined;
  let seatProcesses: Awaited<ReturnType<typeof startCoreSeats>> | undefined;
  let mail: Context.Service.Shape<typeof MachineCoreMail> | undefined;
  let releaseRunner: (() => void) | undefined;
  const runtime = makeCoreRuntime({ ...options, ready: () => admitted && !stopping && owner?.ready() === true && listener?.ready() === true });
  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    stopping = true;
    admitted = false;
    owner?.beginShutdown();
    listener?.beginShutdown();
    work?.beginShutdown();
    mail?.seats.suspend();
    seatProcesses?.beginShutdown();
    closeFlight = (async () => {
      if (owner !== undefined) {
        const receipt = await owner.close();
        if (!receipt.clean) throw new Error("Owner commands did not drain; core state retained");
      }
      if (listener !== undefined) await listener.close();
      if (work !== undefined) {
        const receipt = await work.close();
        if (!receipt.clean) throw new Error("Seat work commands did not drain; core state retained");
      }
      await seatProcesses?.close();
      const writes = await mainAuthoringGate.drain(5_000);
      if (writes.remaining.length > 0) throw new Error("Core writes did not drain; core state retained");
      await runtime.dispose();
      const children = await quiesceServiceChildrenOnQuit();
      if (!children.clean) throw new Error("Core service children did not drain");
      releaseRunner?.();
    })();
    return closeFlight;
  };
  try {
    releaseRunner = installCoreRunner(runtime);
    const [actions, link, status, rows, seats, coreMail] = await runtime.runPromise(Effect.all([MachineOwnerControl, MachineLink, MachineCoreStatus, MachineCoreRows, MachineCoreSeats, MachineCoreMail]));
    mail = coreMail;
    work = await startWorkControlServer({
      home: options.home, workHome: workControlDir(options.home),
      version: typeof __JUNTO_APP_VERSION__ === "string" ? __JUNTO_APP_VERSION__ : "dev",
      run: effect => runtime.runPromise(effect),
    });
    seatProcesses = await startCoreSeats({ home: options.home });
    await runtime.runPromise(link.setChannels({ status: status.handler, rows: rows.handler, seats: seats.handler }));
    listener = await runtime.runPromise(link.listen(options.home));
    owner = await startOperatorControlServer({ home: options.home, dispatch: (request) => runtime.runPromise(actions.dispatch(request)) });
    await runtime.runPromise(mail.boot({
      runPromise: effect => runtime.runPromise(effect),
      runFork: effect => { runtime.runFork(effect); },
    }));
    admitted = true;
    return { runtime, close, ready: () => admitted && !stopping && owner!.ready() && listener!.ready() };
  } catch (cause) {
    await close();
    throw cause;
  }
};
