/**
 * A Boat machine's route, waking and sleep, on the editing machine
 * (docs/machines.md, Boat machines).
 *
 * The route is found at every dial and never stored as truth: an awake
 * machine gets Junto's own SSH key installed through Boat's API, and the one
 * host key Boat answered is written to that machine's own known-hosts file, so
 * the dial checks it strictly. A sleeping machine is refused as asleep; only
 * `wake` resumes one, and only work calls it.
 */
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { BOAT_LEASE_SECONDS, boatPower, type BoatMachineView, type BoatPower as Power } from "@shared/boat";
import type { RemoteHost } from "@shared/remote-hosts";
import { LinkUnavailable } from "../link/types";
import type { BoatClient, BoatRun, BoatSandbox } from "./client";
import { boatHostKeyAlias, ensureBoatSshKey, readBoatRecords, writeBoatKnownHost, type BoatMachineRecord } from "./files";

const DISK_KEPT_MS = 14 * 24 * 60 * 60_000;
const AWAKE_WAIT_MS = 150_000;
const ASLEEP_WAIT_MS = 90_000;
const CORE_WAIT_MS = 120_000;
const POLL_MS = 2_000;

export class BoatMachineRefused extends Schema.TaggedError<BoatMachineRefused>()("BoatMachineRefused", {
  machine: Schema.String,
  check: Schema.Literals(["not-boat", "did-not-wake", "did-not-sleep", "gone", "failed"]),
  message: Schema.String,
}) {}

export const viewOf = (record: BoatMachineRecord, sandbox: BoatSandbox): BoatMachineView => {
  const power = boatPower(sandbox.state);
  const asleepSince = power === "asleep" ? sandbox.stop?.endedAt ?? sandbox.updatedAt ?? undefined : undefined;
  const kept = asleepSince === undefined ? Number.NaN : Date.parse(asleepSince) + DISK_KEPT_MS;
  return {
    machineName: record.name, sandboxId: record.sandboxId, size: record.size, power,
    ...(power === "awake" && sandbox.archiveAfter ? { deadline: sandbox.archiveAfter } : {}),
    ...(asleepSince === undefined ? {} : { asleepSince }),
    ...(Number.isFinite(kept) ? { diskKeptUntil: new Date(kept).toISOString() } : {}),
  };
};

/** OpenSSH's SHA256 fingerprint of a one-line public key. */
export const hostKeyFingerprint = (line: string): string =>
  `SHA256:${createHash("sha256").update(Buffer.from(line.split(" ")[1] ?? "", "base64")).digest("base64").replace(/=+$/, "")}`;

export interface BoatMachinesDeps {
  /** Runs a Boat request in the core's own runtime. */
  readonly run: BoatRun;
  readonly home: string;
  readonly client: BoatClient;
  readonly getHost: (name: string) => Promise<RemoteHost | undefined>;
  readonly upsertHost: (host: RemoteHost) => Promise<void>;
  /** Opens the link (route included); used to wait for a woken machine's core. */
  readonly connect: (host: RemoteHost) => Promise<void>;
  readonly disconnect: (name: string) => Promise<void>;
  readonly log: (level: "Info" | "Warning", message: string, fields: Record<string, unknown>) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface BoatRouteFields {
  readonly sshEndpoint: string;
  readonly sshPort: number;
  readonly sshIdentityFile: string;
  readonly sshKnownHostsFile: string;
  readonly sshHostKeyAlias: string;
}

export interface BoatMachines {
  /** The route to dial. Another machine passes as it is; a sleeping Boat one is refused. */
  readonly route: (host: RemoteHost) => Promise<RemoteHost>;
  /** Wakes a Boat machine and waits for its core; any other machine is left alone. */
  readonly wakeIfBoat: (name: string) => Promise<void>;
  /** Resumes it when asleep and waits until Boat says it is awake; with `core`, until its core answers a link. */
  readonly wake: (name: string, options?: { readonly core?: boolean }) => Promise<BoatMachineView>;
  /** The SSH fields of an awake machine's route, found now. */
  readonly routeFields: (name: string) => Promise<BoatRouteFields>;
  readonly sleep: (name: string) => Promise<BoatMachineView>;
  readonly view: (name: string) => Promise<BoatMachineView>;
  readonly record: (name: string) => Promise<BoatMachineRecord | undefined>;
}

export const makeBoatMachines = (deps: BoatMachinesDeps): BoatMachines => {
  const pause = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;
  const record = async (name: string) => (await readBoatRecords(deps.home)).machines.find((row) => row.name === name);
  const required = async (name: string) => {
    const found = await record(name);
    if (found === undefined) throw new BoatMachineRefused({ machine: name, check: "not-boat", message: `${name} is not a Boat machine` });
    return found;
  };
  const sandbox = (row: BoatMachineRecord) => deps.run(deps.client.sandbox(row.sandboxId));
  const until = async (row: BoatMachineRecord, done: (power: Power) => boolean, waitMs: number): Promise<BoatSandbox | undefined> => {
    const deadline = now() + waitMs;
    for (;;) {
      const current = await sandbox(row);
      if (done(boatPower(current.state))) return current;
      if (now() >= deadline) return undefined;
      await pause(POLL_MS);
    }
  };

  /** Installs Junto's key and pins the one host key Boat answered: the route's SSH fields. */
  const routeFields = async (row: BoatMachineRecord): Promise<BoatRouteFields> => {
    const { identityFile, publicKey } = await ensureBoatSshKey(deps.home);
    const answer = await deps.run(deps.client.installSshKey(row.sandboxId, publicKey));
    const pinned = await writeBoatKnownHost(deps.home, row.sandboxId, answer.hostKey);
    if (pinned.previous !== undefined) {
      deps.log("Info", "Boat machine host key changed", {
        machine: row.name, sandboxId: row.sandboxId,
        previousHostKey: hostKeyFingerprint(pinned.previous), hostKey: hostKeyFingerprint(answer.hostKey),
      });
    }
    const forward = answer.sshEndpoint ?? undefined;
    const [address, port] = forward !== undefined
      ? [forward.slice(0, forward.lastIndexOf(":")), Number(forward.slice(forward.lastIndexOf(":") + 1))]
      : [answer.machineIp ?? undefined, 22];
    if (address === undefined) throw new LinkUnavailable({ machine: row.name, reason: "route-incomplete", message: `Boat gave no address for ${row.name}` });
    return {
      sshEndpoint: `${answer.sshUser}@${address}`, sshPort: port, sshIdentityFile: identityFile,
      sshKnownHostsFile: pinned.path, sshHostKeyAlias: boatHostKeyAlias(row.sandboxId),
    };
  };

  /** The route found now, kept in the machine list when it changed. */
  const refresh = async (row: BoatMachineRecord, host: RemoteHost): Promise<RemoteHost> => {
    const next: RemoteHost = { ...host, ...await routeFields(row) };
    if (next.sshEndpoint !== host.sshEndpoint || next.sshPort !== host.sshPort || next.sshIdentityFile !== host.sshIdentityFile ||
      next.sshKnownHostsFile !== host.sshKnownHostsFile || next.sshHostKeyAlias !== host.sshHostKeyAlias) {
      await deps.upsertHost(next);
    }
    return next;
  };

  const asleep = (name: string) => new LinkUnavailable({ machine: name, reason: "asleep",
    message: `${name} is asleep. It wakes when a seat on it starts or gets mail, or with junto machine wake` });

  const route = async (host: RemoteHost): Promise<RemoteHost> => {
    const row = await record(host.id);
    if (row === undefined) return host;
    let current = await sandbox(row);
    if (boatPower(current.state) === "waking") current = await until(row, (power) => power !== "waking", AWAKE_WAIT_MS) ?? current;
    switch (boatPower(current.state)) {
      case "awake": return refresh(row, host);
      case "asleep": case "falling-asleep": throw asleep(host.id);
      case "gone": throw new LinkUnavailable({ machine: host.id, reason: "route-incomplete", message: `${host.id}'s Boat sandbox is gone` });
      default: throw new LinkUnavailable({ machine: host.id, reason: "route-incomplete", message: `${host.id}'s Boat sandbox is not answering` });
    }
  };

  const flights = new Map<string, Promise<BoatMachineView>>();
  const wakeOnce = async (name: string, core: boolean): Promise<BoatMachineView> => {
    const row = await required(name);
    let current = await sandbox(row);
    if (boatPower(current.state) === "falling-asleep") current = await until(row, (power) => power === "asleep", ASLEEP_WAIT_MS) ?? current;
    if (boatPower(current.state) === "asleep") {
      deps.log("Info", "waking Boat machine", { machine: name, sandboxId: row.sandboxId });
      await deps.run(deps.client.resume(row.sandboxId, BOAT_LEASE_SECONDS));
    }
    if (boatPower(current.state) === "gone") throw new BoatMachineRefused({ machine: name, check: "gone", message: `${name}'s Boat sandbox is gone` });
    const awake = await until(row, (power) => power === "awake", AWAKE_WAIT_MS);
    if (awake === undefined) throw new BoatMachineRefused({ machine: name, check: "did-not-wake", message: `${name} did not wake in time` });
    // The core starts with the machine; the link answers once it is up.
    const host = core ? await deps.getHost(name) : undefined;
    if (host !== undefined) {
      const deadline = now() + CORE_WAIT_MS;
      for (;;) {
        try { await deps.connect(host); break; } catch (cause) {
          if (now() >= deadline) throw cause;
          await pause(3_000);
        }
      }
    }
    return viewOf(row, await sandbox(row));
  };
  const wake = (name: string, options: { readonly core?: boolean } = {}): Promise<BoatMachineView> => {
    const key = `${name}\u0000${options.core !== false}`;
    const pending = flights.get(key);
    if (pending !== undefined) return pending;
    const flight = wakeOnce(name, options.core !== false).finally(() => flights.delete(key));
    flights.set(key, flight);
    return flight;
  };

  return {
    route,
    wakeIfBoat: async (name) => { if (await record(name) !== undefined) await wake(name); },
    wake,
    routeFields: async (name) => routeFields(await required(name)),
    sleep: async (name) => {
      const row = await required(name);
      await deps.disconnect(name).catch(() => undefined);
      const current = await sandbox(row);
      if (boatPower(current.state) === "awake" || boatPower(current.state) === "waking") await deps.run(deps.client.stop(row.sandboxId));
      const settled = await until(row, (power) => power === "asleep", ASLEEP_WAIT_MS);
      if (settled === undefined) throw new BoatMachineRefused({ machine: name, check: "did-not-sleep", message: `${name} did not fall asleep in time` });
      return viewOf(row, settled);
    },
    view: async (name) => {
      const row = await required(name);
      return viewOf(row, await sandbox(row));
    },
    record,
  };
};

// --- The one instance this process runs ---------------------------------------

let active: BoatMachines | undefined;
/** Installed by the core that holds the Boat account; answers how to uninstall. */
export const installBoatMachines = (machines: BoatMachines): (() => void) => {
  active = machines;
  return () => { if (active === machines) active = undefined; };
};
/** The route a link dials; any machine when Boat is not set up here. */
export const boatRoute = (host: RemoteHost): Promise<RemoteHost> => active === undefined ? Promise.resolve(host) : active.route(host);
/** Wakes the machine when it is a sleeping Boat machine, before work that needs it. */
export const wakeBoatMachine = (name: string): Promise<void> => active === undefined ? Promise.resolve() : active.wakeIfBoat(name);
