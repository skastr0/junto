/**
 * On a Boat machine: the lease (docs/machines.md, Boat machines). Boat stops
 * the machine at its deadline; while the machine is busy, its core moves the
 * deadline one lease out with the machine key, every few minutes. When it is
 * idle the core does nothing, and Boat stops it with its disk saved. A core
 * that dies costs at most one lease.
 */
import { Effect } from "effect";
import { BOAT_LEASE_RENEW_MS, BOAT_LEASE_SECONDS } from "@shared/boat";
import { registerKnownSecrets } from "../credentials/scrub";
import { boatFailureMessage, makeBoatClient, type BoatFetch, type BoatRun } from "./client";
import { readBoatMachineSelf } from "./files";

/** The first look waits this long after boot, so a seat woken by mail is already working. */
const FIRST_LOOK_MS = 60_000;

export interface BoatLeaseDeps {
  /** Runs a Boat request in the core's own runtime. */
  readonly run: BoatRun;
  readonly home: string;
  /** Whether a seat here is working, or terminal bytes moved recently. */
  readonly busy: () => boolean;
  readonly log: (level: "Info" | "Warning", message: string, fields: Record<string, unknown>) => void;
  readonly fetch?: BoatFetch;
  readonly every?: number;
  readonly first?: number;
}

/** Starts the lease when this machine holds a machine key; answers how to stop it. */
export const startBoatLease = (deps: BoatLeaseDeps): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    // Read each time: the key arrives after Junto is first sent here.
    const mine = await readBoatMachineSelf(deps.home).catch((cause: unknown) => {
      deps.log("Warning", "Boat machine key unreadable", { detail: boatFailureMessage(cause, "unreadable") });
      return undefined;
    });
    if (mine === undefined) return;
    registerKnownSecrets("boat-machine-key", [mine.key]);
    if (!deps.busy()) return;
    const client = makeBoatClient({ key: Effect.succeed(mine.key), ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
    await deps.run(client.lease(mine.self.sandboxId, BOAT_LEASE_SECONDS)).then(
      () => undefined,
      (cause: unknown) => deps.log("Warning", "Boat lease not renewed", {
        sandboxId: mine.self.sandboxId, detail: boatFailureMessage(cause, "failed"),
      }),
    );
  };
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void tick().finally(() => schedule(deps.every ?? BOAT_LEASE_RENEW_MS)); }, ms);
    timer.unref?.();
  };
  schedule(deps.first ?? FIRST_LOOK_MS);
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
};
