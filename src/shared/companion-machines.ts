/**
 * What the phone's machines tab reads, mapped from the owner's own answers
 * (`machine.list`, `machine.status`, `machine.harnesses`, `machine.logs`) and
 * the tailnet reader. Read only, and narrower than the owner: no SSH
 * endpoint, path, key, pin, installation id or pid reaches the phone.
 *
 * The phone is one more hop, so every free text is scrubbed again here, by
 * the scrub main passes in: messages, failures, details (`message`), and the
 * tailnet's outside strings (`name`). Typed fields are checked against their
 * own schemas instead, and dropped when they fail.
 */

import { Schema } from "effect";
import { failureSentence, type EncodedFailure } from "./failure";
import type { MachineHarnesses, MachineListData, MachineOwnStatus, MachinePeerStatus } from "./machine-control";
import { isValidMachineName } from "./machine-identity";
import { LogCanvasName, LogSeatId, type MachineLogRead } from "./machine-log";
import { matchTailscalePeer, type TailscalePeer, type TailscaleStatusSnapshot } from "./tailscale-peers";
import {
  COMPANION_MACHINE_CHECK_AGO_MAX_MS,
  COMPANION_MACHINE_TEXT_MAX,
  type CompanionMachine,
  type CompanionMachineFailure,
  type CompanionMachineLogs,
  type CompanionMachineStatus,
  type CompanionTailnetPeer,
} from "./wire/companion-protocol";

type ListedMachine = MachineListData["machines"][number];

/** Main passes the credential scrub; the demo's data is its own and clean. */
export type CompanionMachineScrub = {
  /** Steps 2 to 4: a message, a failure, a detail. */
  readonly message: (text: string) => string;
  /** Step 2 alone: an outside name. */
  readonly name: (text: string) => string;
};

/** The newest read of one machine, kept in main for `machines.list`. */
export type CompanionMachineCheck = {
  readonly at: number;
  readonly reachable: boolean;
  readonly form?: CompanionMachine["form"];
  readonly failure?: CompanionMachineFailure;
};

/** The sentences a log that could not be read is told with: classified, never the link's own error. */
export const MACHINE_LOG_UNAVAILABLE = {
  notSetUp: "Set up this machine to read its log.",
  unreachable: "This machine could not be reached, so its log could not be read.",
  failed: "This machine's log could not be read.",
} as const;

const FAILURE_TAG = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const BUILD = /^[0-9a-f]{64}$/u;
const isCanvas = Schema.is(LogCanvasName);
const isSeat = Schema.is(LogSeatId);

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export const companionMachineFailure = (failure: EncodedFailure, scrub: CompanionMachineScrub): CompanionMachineFailure => {
  const tag = FAILURE_TAG.test(failure.tag) ? failure.tag : "Failure";
  const message = clip(scrub.message(failureSentence(failure)), COMPANION_MACHINE_TEXT_MAX);
  return { tag, message: message === "" ? tag : message };
};

/** The tailnet device each machine is, by the same match the link uses for its mesh host. */
export const tailnetPeersByMachine = (
  machines: ReadonlyArray<ListedMachine>,
  snapshot: TailscaleStatusSnapshot | undefined,
): ReadonlyMap<string, TailscalePeer> => {
  const out = new Map<string, TailscalePeer>();
  if (snapshot === undefined) return out;
  for (const { machine } of machines) {
    const peer = machine.isThisMachine
      ? snapshot.self
      : matchTailscalePeer({ hostId: machine.id, ...(machine.sshEndpoint === undefined ? {} : { sshEndpoint: machine.sshEndpoint }) }, snapshot);
    if (peer !== undefined) out.set(machine.id, peer);
  }
  return out;
};

export const companionMachines = (
  machines: ReadonlyArray<ListedMachine>,
  snapshot: TailscaleStatusSnapshot | undefined,
  checks: ReadonlyMap<string, CompanionMachineCheck>,
  now: number,
  scrub: CompanionMachineScrub,
): ReadonlyArray<CompanionMachine> => {
  const peers = tailnetPeersByMachine(machines, snapshot);
  return machines
    .filter(({ machine }) => isValidMachineName(machine.id))
    .map(({ machine, setUp, needsUpdate }) => {
      const peer = peers.get(machine.id);
      const check = checks.get(machine.id);
      const ago = check === undefined ? undefined : Math.max(0, Math.round(now - check.at));
      const label = clip(scrub.name(machine.label), 64);
      return {
        name: machine.id,
        label: label === "" ? machine.id : label,
        thisMachine: machine.isThisMachine,
        ...(check?.form === undefined ? {} : { form: check.form }),
        setUp,
        needsUpdate,
        tailnet: peer?.online === undefined ? "unknown" : peer.online ? "online" : "offline",
        ...(check === undefined || ago === undefined || ago > COMPANION_MACHINE_CHECK_AGO_MAX_MS
          ? {}
          : { lastCheck: { checkedAgoMs: ago, reachable: check.reachable, ...(check.failure === undefined ? {} : { failure: check.failure }) } }),
      } satisfies CompanionMachine;
    });
};

/** One machine as its status read says, here or across its link. */
export const companionMachineStatus = (
  status: MachineOwnStatus | MachinePeerStatus,
  harnesses: MachineHarnesses["harnesses"],
  scrub: CompanionMachineScrub,
): CompanionMachineStatus => {
  const own = "build" in status;
  const keychain = status.keychain;
  const detail = !own && status.detail !== undefined ? clip(scrub.message(status.detail), 1024) : "";
  return {
    reachable: own ? true : status.reachable,
    ...(own && BUILD.test(status.build) ? { build: status.build.slice(0, 12) } : {}),
    ...(keychain === undefined ? {} : { keychain }),
    harnesses: harnesses.slice(0, 32).map((entry) => ({
      harness: clip(entry.harness, 64),
      installed: entry.installed,
      ...(entry.signIn === undefined ? {} : { signIn: entry.signIn }),
    })),
    missingSecrets: own ? [] : status.missingSecrets.filter((name) => SECRET_NAME.test(name)).slice(0, 64),
    ...(detail === "" ? {} : { detail }),
    ...(!own && status.failure !== undefined ? { failure: companionMachineFailure(status.failure, scrub) } : {}),
  };
};

export const companionMachineCheck = (
  status: MachineOwnStatus | MachinePeerStatus,
  at: number,
  scrub: CompanionMachineScrub,
): CompanionMachineCheck => {
  const view = companionMachineStatus(status, [], scrub);
  return {
    at,
    reachable: view.reachable,
    ...(status.form === undefined ? {} : { form: status.form }),
    ...(view.failure === undefined ? {} : { failure: view.failure }),
  };
};

export const companionMachineLogs = (read: MachineLogRead, limit: number, scrub: CompanionMachineScrub): CompanionMachineLogs => {
  const rows = read.rows.slice(-limit);
  return {
    rows: rows.map((row) => ({
      time: clip(row.time, 32),
      level: row.level,
      area: row.area,
      message: clip(scrub.message(row.message), COMPANION_MACHINE_TEXT_MAX),
      ...(row.canvas !== undefined && isCanvas(row.canvas) ? { canvas: row.canvas } : {}),
      ...(row.seat !== undefined && isSeat(row.seat) ? { seat: row.seat } : {}),
      ...(row.failure === undefined ? {} : { failure: companionMachineFailure(row.failure, scrub) }),
    })),
    cut: read.cut || read.rows.length > rows.length,
  };
};

/**
 * Every device on the tailnet but this one, and the Junto machine each is.
 * Only these five fields: never an address, a node key or id, or a user.
 */
export const companionTailnetPeers = (
  machines: ReadonlyArray<ListedMachine>,
  snapshot: TailscaleStatusSnapshot,
  scrub: CompanionMachineScrub,
): ReadonlyArray<CompanionTailnetPeer> => {
  const byPeer = new Map<TailscalePeer, string>();
  for (const [name, peer] of tailnetPeersByMachine(machines, snapshot)) byPeer.set(peer, name);
  const text = (value: string | undefined, max: number): string | undefined => {
    if (value === undefined) return undefined;
    const clean = clip(scrub.name(value).replace(/\.+$/u, ""), max);
    return clean === "" ? undefined : clean;
  };
  const out: CompanionTailnetPeer[] = [];
  for (const peer of snapshot.peers) {
    const dnsName = text(peer.dnsName, 255);
    const name = text(peer.hostName, 64) ?? text(dnsName?.split(".")[0], 64);
    if (name === undefined) continue;
    const os = text(peer.os, 32);
    const machine = byPeer.get(peer);
    out.push({
      name,
      ...(dnsName === undefined ? {} : { dnsName }),
      ...(os === undefined ? {} : { os }),
      online: peer.online === true,
      ...(machine === undefined || !isValidMachineName(machine) ? {} : { machine }),
    });
    if (out.length === 128) break;
  }
  return out;
};
