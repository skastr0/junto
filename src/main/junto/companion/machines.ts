/**
 * The phone's machines tab in the running app: the owner actions the window
 * uses (`machine.list`, `machine.status`, `machine.harnesses`, `machine.logs`)
 * and the cached tailnet reader, mapped by `@shared/companion-machines`.
 * Read only: nothing here adds, sends, updates or removes a machine.
 *
 * Every free text is scrubbed here, at the one place it is encoded for the
 * phone; the owner's rows alone are not enough (this machine's own log rows
 * are read back as written, and a peer's detail is only bounded).
 */

import { Effect } from "effect";
import { ulid } from "ulid";
import {
  companionMachineCheck,
  companionMachineLogs,
  companionMachineStatus,
  companionMachines,
  companionTailnetPeers,
  MACHINE_LOG_UNAVAILABLE,
  type CompanionMachineCheck,
} from "@shared/companion-machines";
import { outcomeFail, outcomeOk, type CompanionBackend } from "@shared/companion-core";
import { COMPANION_MACHINE_LOG_ROWS } from "@shared/companion-protocol";
import type { MachineHarnesses, MachineListData, MachineOwnStatus, MachinePeerStatus } from "@shared/machine-control";
import { isValidMachineName } from "@shared/machine-identity";
import type { MachineLogRead } from "@shared/machine-log";
import { OPERATOR_PROTOCOL_VERSION, type OperatorRequestEnvelope } from "@shared/operator-control";
import { CompanionRuntime } from "./runtime";
import { MachineOwnerControl } from "../hosts/machine-owner";
import { noteMachinesChanged } from "../hosts/machine-changes";
import { tailscalePeerCache } from "../hosts/tailscale-peers";
import { companionMachineScrub } from "./machine-scrub";

const scrub = companionMachineScrub;

/** The newest read of each machine a phone asked for, while the app runs. */
const checks = new Map<string, CompanionMachineCheck>();

type Owned<A> = { readonly ok: true; readonly data: A } | { readonly ok: false; readonly type: string };

const owner = async <A>(op: OperatorRequestEnvelope["op"], args: object): Promise<Owned<A>> => {
  const request = { protocol: OPERATOR_PROTOCOL_VERSION, id: `companion.${ulid()}`, op, args } as OperatorRequestEnvelope;
  const response = await CompanionRuntime.runPromise(Effect.flatMap(MachineOwnerControl, (actions) => actions.dispatch(request)));
  return response.ok ? { ok: true, data: (response as unknown as { readonly data: A }).data } : { ok: false, type: response.error.type };
};

const listed = async (): Promise<MachineListData["machines"] | undefined> => {
  const list = await owner<MachineListData>("machine.list", {});
  return list.ok ? list.data.machines : undefined;
};

const LIST_FAILED = "Could not read this Mac's machines.";

export const companionMachineBackend: Pick<CompanionBackend, "machines" | "machine" | "tailnetPeers"> = {
  machines: async () => {
    const machines = await listed();
    if (machines === undefined) return outcomeFail("internal", LIST_FAILED);
    return outcomeOk(companionMachines(machines, await tailscalePeerCache.current(), checks, Date.now(), scrub));
  },

  machine: async (name, minLevel) => {
    const machines = await listed();
    if (machines === undefined) return outcomeFail("internal", LIST_FAILED);
    const item = isValidMachineName(name) ? machines.find(({ machine }) => machine.id === name) : undefined;
    if (item === undefined) return outcomeFail("not-found", isValidMachineName(name) ? `No machine named ${name} on this Mac.` : "No such machine on this Mac.");
    const own = item.machine.isThisMachine;
    const status = await owner<MachineOwnStatus | MachinePeerStatus>("machine.status", { name });
    if (!status.ok) return outcomeFail(status.type === "not_found" ? "not-found" : "internal", "This machine could not be read.");
    // A peer's status carries its harnesses; this machine reports them apart.
    const harnesses = own
      ? await owner<MachineHarnesses>("machine.harnesses", { name })
      : { ok: true as const, data: status.data as MachinePeerStatus };
    const view = companionMachineStatus(status.data, harnesses.ok ? harnesses.data.harnesses : [], scrub);
    const logs = !own && !item.setUp
      ? { unavailable: MACHINE_LOG_UNAVAILABLE.notSetUp }
      : !view.reachable
        ? { unavailable: MACHINE_LOG_UNAVAILABLE.unreachable }
        : await owner<MachineLogRead>("machine.logs", {
            name,
            query: { limit: COMPANION_MACHINE_LOG_ROWS, ...(minLevel === undefined ? {} : { level: minLevel }) },
          }).then((read) => (read.ok ? companionMachineLogs(read.data, COMPANION_MACHINE_LOG_ROWS, scrub) : { unavailable: MACHINE_LOG_UNAVAILABLE.failed }));
    const now = Date.now();
    checks.set(name, companionMachineCheck(status.data, now, scrub));
    noteMachinesChanged();
    const machine = companionMachines([item], await tailscalePeerCache.current(), checks, now, scrub)[0];
    if (machine === undefined) return outcomeFail("not-found", "No such machine on this Mac.");
    return outcomeOk({ machine, status: view, logs });
  },

  tailnetPeers: async () => {
    const snapshot = await tailscalePeerCache.current();
    if (snapshot === undefined) return outcomeOk({ available: false, peers: [] });
    return outcomeOk({ available: true, peers: companionTailnetPeers((await listed()) ?? [], snapshot, scrub) });
  },
};

/** Tests: forget every check. */
export const resetCompanionMachineChecks = (): void => {
  checks.clear();
};
