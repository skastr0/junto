/**
 * Registry of per-host herdr mirrors (default session only). Construction is
 * lazy and side-effect free — nothing connects or spawns until start(). An
 * un-started mirror reports isFresh() === false, so callers (HerdrService)
 * simply fall back to the exec path.
 */
import { HERDR_HOSTS, isKnownHerdrHost, sshTargetForHost } from "./hosts";
import { HerdrMirror } from "./mirror";
import { LocalMirrorTransport, RemoteMirrorTransport } from "./mirror-transport";

const registry = new Map<string, HerdrMirror>();

export const mirrorFor = (hostId: string): HerdrMirror | undefined => {
  if (!isKnownHerdrHost(hostId)) return undefined;
  let mirror = registry.get(hostId);
  if (!mirror) {
    const transport = sshTargetForHost(hostId)
      ? new RemoteMirrorTransport(hostId)
      : new LocalMirrorTransport();
    mirror = new HerdrMirror(hostId, transport);
    registry.set(hostId, mirror);
  }
  return mirror;
};

/** Start every known host's mirror (app-ready hook, after warmAllHosts). */
export const startAllMirrors = (): void => {
  for (const host of HERDR_HOSTS) mirrorFor(host.id)?.start();
};

/** Stop and drop every mirror (app quit). Idempotent. */
export const stopAllMirrors = (): void => {
  for (const mirror of registry.values()) {
    try {
      mirror.stop();
    } catch {
      // quit path never throws
    }
  }
  registry.clear();
};

export interface HerdrMirrorHostState {
  readonly hostId: string;
  readonly fresh: boolean;
  readonly lastSyncAt?: number;
}

export const mirrorStates = (): ReadonlyArray<HerdrMirrorHostState> =>
  HERDR_HOSTS.map((host) => {
    const mirror = registry.get(host.id);
    return {
      hostId: host.id,
      fresh: mirror?.isFresh() ?? false,
      lastSyncAt: mirror?.lastSyncAt,
    };
  });
