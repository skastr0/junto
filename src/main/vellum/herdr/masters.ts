/**
 * Warm SSH transport for herdr remote hosts: stock OpenSSH ControlMaster
 * connection reuse (herdr itself uses this exact pattern internally — no
 * herdr patches, no protocol extensions). Every fresh `ssh remote-a herdr
 * ...` child otherwise pays a full handshake (measured 310-500ms on this
 * network); a warm ControlMaster socket collapses that to 40-120ms.
 *
 * Also owns a per-host concurrency limiter so warm exec traffic respects
 * sshd MaxSessions on the remote.
 */
import { mkdir } from "node:fs/promises";
import { runCli, type CliResult } from "../adapters/exec";
import { controlArgs, herdrControlDir } from "./control-path";
import { HERDR_HOSTS, sshTargetForHost } from "./hosts";

// Mirrors the base ssh flags hosts.ts / stage-image.ts use for remote spawns.
const BASE_SSH_ARGS = [
  "-o",
  "ConnectTimeout=6",
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
] as const;

const WARM_TIMEOUT_MS = 8_000;

/** Injectable so tests can record argv without spawning real ssh. */
export type MasterRunner = (
  command: string,
  argv: ReadonlyArray<string>,
  timeoutMs?: number,
) => Promise<CliResult>;

const defaultRunner: MasterRunner = runCli;

/** ssh writes the control socket but never creates its parent dir. Control
 * sockets grant live connection access, so 0o700 (owner-only). */
export const ensureControlDir = async (): Promise<void> => {
  await mkdir(herdrControlDir(), { recursive: true, mode: 0o700 });
};

/**
 * Best-effort: open (or refresh) the ControlMaster for one remote host.
 * No-ops for "local" and unknown hosts. Never throws — warming is purely
 * opportunistic and must never block or fail the caller's real op.
 */
export const warmHost = async (
  hostId: string,
  runner: MasterRunner = defaultRunner,
): Promise<void> => {
  const sshTarget = sshTargetForHost(hostId);
  if (!sshTarget) return; // "local" or unknown — nothing to warm
  try {
    await ensureControlDir();
    await runner(
      "ssh",
      [...BASE_SSH_ARGS, ...controlArgs(), sshTarget, "true"],
      WARM_TIMEOUT_MS,
    );
  } catch {
    // swallow — warming failures never propagate to the caller
  }
};

/** Warm every remote host in HERDR_HOSTS (local no-ops inside warmHost). */
export const warmAllHosts = async (runner?: MasterRunner): Promise<void> => {
  await Promise.all(HERDR_HOSTS.map((host) => warmHost(host.id, runner)));
};

// --- per-host concurrency limiter -----------------------------------------
// Budgets remote exec ops against sshd MaxSessions=10 on the remote-a: 3 exec
// slots + 1 control stream + headroom for a later observe pool. "local" has
// no sshd session to protect, so it bypasses the limiter entirely.

const MAX_CONCURRENT_PER_HOST = 3;

interface HostSlot {
  active: number;
  readonly queue: Array<() => void>;
}

const hostSlots = new Map<string, HostSlot>();

const slotFor = (hostId: string): HostSlot => {
  let slot = hostSlots.get(hostId);
  if (!slot) {
    slot = { active: 0, queue: [] };
    hostSlots.set(hostId, slot);
  }
  return slot;
};

const acquireSlot = (hostId: string): Promise<void> => {
  const slot = slotFor(hostId);
  if (slot.active < MAX_CONCURRENT_PER_HOST) {
    slot.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => slot.queue.push(resolve));
};

const releaseSlot = (hostId: string): void => {
  const slot = hostSlots.get(hostId);
  if (!slot) return;
  const next = slot.queue.shift();
  if (next) {
    // Hand the slot straight to the next waiter — active count is unchanged.
    next();
    return;
  }
  slot.active = Math.max(0, slot.active - 1);
};

/** Run fn() inside this remote host's concurrency budget (max 3 in flight,
 * FIFO queue beyond that). "local" bypasses the limiter entirely. */
export const withHostSlot = async <T>(hostId: string, fn: () => Promise<T>): Promise<T> => {
  if (hostId === "local") return fn();
  await acquireSlot(hostId);
  try {
    return await fn();
  } finally {
    releaseSlot(hostId);
  }
};
