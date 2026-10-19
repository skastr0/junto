/**
 * The Boat keeper, on the editing machine, once a minute, for the Boat
 * machines in its list only (docs/machines.md, Boat machines):
 *
 * - an awake machine gets a link, so rows flow both ways while it is up;
 * - a sleeping machine is woken once for each new mail held for a seat on it,
 *   once when this machine starts after it fell asleep (to collect what it
 *   holds), and after 12 days asleep (to keep its disk);
 * - a deadline missing, or more than one lease away, is set back and logged.
 */
import { Effect } from "effect";
import { BOAT_KEEP_DISK_AFTER_MS, BOAT_LEASE_SECONDS, boatPower } from "@shared/boat";
import { isPendingDelivery } from "@shared/message-delivery";
import type { RemoteHost } from "@shared/remote-hosts";
import { ModelService } from "../model/service";
import { WorkRepository } from "../work/repository";
import { boatFailureMessage, type BoatClient, type BoatRun } from "./client";
import { readBoatRecords, updateBoatRecords } from "./files";
import { viewOf, type BoatMachines } from "./machines";

const KEEPER_EVERY_MS = 60_000;
/** Slack past one lease before a deadline counts as moved by someone else. */
const DEADLINE_SLACK_MS = 2 * 60_000;

/** The newest mail held for a seat on `machine`, by id, across this machine's canvases. */
export const pendingMailFor = (machine: string) => Effect.gen(function* () {
  const model = yield* ModelService;
  const work = yield* WorkRepository;
  let newest: string | undefined;
  for (const name of yield* model.listCanvases()) {
    const canvas = yield* model.canvas(name);
    for (const node of canvas.nodes.values()) {
      if (node.kind !== "agent" || node.host !== machine) continue;
      for (const message of yield* work.mailbox(name, node.id)) {
        if (isPendingDelivery(message) && (newest === undefined || message.messageId > newest)) newest = message.messageId;
      }
    }
  }
  return newest;
});

export interface BoatKeeperDeps {
  /** Runs a Boat request in the core's own runtime. */
  readonly run: BoatRun;
  readonly home: string;
  readonly client: BoatClient;
  readonly machines: BoatMachines;
  readonly getHost: (name: string) => Promise<RemoteHost | undefined>;
  readonly connect: (host: RemoteHost) => Promise<void>;
  readonly pendingMail: (machine: string) => Promise<string | undefined>;
  readonly log: (level: "Info" | "Warning", message: string, fields: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly every?: number;
}

type Wake = "mail" | "catch-up" | "keep-disk";

/** One pass over every Boat machine; answers which were woken and why. */
export const keepBoatMachines = async (deps: BoatKeeperDeps, first: boolean): Promise<ReadonlyArray<{ readonly name: string; readonly why: Wake }>> => {
  const now = (deps.now ?? Date.now)();
  const records = await readBoatRecords(deps.home);
  if (records.machines.length === 0) return [];
  const lastLook = records.heartbeatAt;
  const woken: Array<{ name: string; why: Wake }> = [];
  await Promise.all(records.machines.map(async (row) => {
    const sandbox = await deps.run(deps.client.sandbox(row.sandboxId)).catch((cause: unknown) => {
      deps.log("Warning", "Boat machine not readable", { machine: row.name, sandboxId: row.sandboxId, detail: boatFailureMessage(cause, "failed") });
      return undefined;
    });
    if (sandbox === undefined) return;
    const power = boatPower(sandbox.state);
    if (power === "awake") {
      const deadline = sandbox.archiveAfter ? Date.parse(sandbox.archiveAfter) : Number.NaN;
      if (!Number.isFinite(deadline) || deadline > now + BOAT_LEASE_SECONDS * 1000 + DEADLINE_SLACK_MS) {
        deps.log("Warning", "Boat machine deadline set back to one lease", { machine: row.name, sandboxId: row.sandboxId });
        await deps.run(deps.client.lease(row.sandboxId, BOAT_LEASE_SECONDS)).catch(() => undefined);
      }
      const host = await deps.getHost(row.name);
      if (host !== undefined) await deps.connect(host).catch(() => undefined);
      return;
    }
    if (power !== "asleep") return;
    const since = Date.parse(viewOf(row, sandbox).asleepSince ?? "");
    const mail = await deps.pendingMail(row.name).catch(() => undefined);
    const why: Wake | undefined =
      mail !== undefined && mail !== row.wokenForMail ? "mail"
        : first && lastLook !== undefined && Number.isFinite(since) && since > lastLook ? "catch-up"
          : Number.isFinite(since) && now - since > BOAT_KEEP_DISK_AFTER_MS ? "keep-disk"
            : undefined;
    if (why === undefined) return;
    if (why === "mail") {
      await updateBoatRecords(deps.home, (current) => ({
        ...current, machines: current.machines.map((m) => m.name === row.name ? { ...m, wokenForMail: mail! } : m),
      }));
    }
    deps.log("Info", "Boat keeper wakes a machine", { machine: row.name, sandboxId: row.sandboxId, reason: why });
    woken.push({ name: row.name, why });
    await deps.machines.wake(row.name).catch((cause: unknown) => {
      deps.log("Warning", "Boat machine did not wake", { machine: row.name, sandboxId: row.sandboxId, detail: boatFailureMessage(cause, "failed") });
    });
  }));
  await updateBoatRecords(deps.home, (current) => ({ ...current, heartbeatAt: now }));
  return woken;
};

/** Runs the keeper while this machine runs; answers how to stop it. */
export const startBoatKeeper = (deps: BoatKeeperDeps): (() => void) => {
  let stopped = false;
  let first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void keepBoatMachines(deps, first)
        .catch((cause: unknown) => deps.log("Warning", "Boat keeper pass failed", { detail: boatFailureMessage(cause, "failed") }))
        .finally(() => { first = false; schedule(deps.every ?? KEEPER_EVERY_MS); });
    }, ms);
    timer.unref?.();
  };
  schedule(5_000);
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
};
