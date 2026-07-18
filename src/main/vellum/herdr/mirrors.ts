import { HERDR_HOSTS, isKnownHerdrHost } from "./hosts";
import { HerdrMirror } from "./mirror";
import type { MirrorTransport } from "./mirror-transport";

export interface HerdrMirrorHostState {
  readonly hostId: string;
  readonly fresh: boolean;
  readonly lastSyncAt?: number;
}

export class HerdrMirrorRegistry {
  private readonly registry = new Map<string, HerdrMirror>();

  constructor(private readonly makeTransport: (hostId: string) => MirrorTransport) {}

  mirrorFor(hostId: string): HerdrMirror | undefined {
    if (!isKnownHerdrHost(hostId)) return undefined;
    let mirror = this.registry.get(hostId);
    if (!mirror) {
      mirror = new HerdrMirror(hostId, this.makeTransport(hostId));
      this.registry.set(hostId, mirror);
    }
    return mirror;
  }

  startAll(): void {
    for (const host of HERDR_HOSTS) this.mirrorFor(host.id)?.start();
  }

  stopAll(): void {
    for (const mirror of this.registry.values()) {
      try {
        mirror.stop();
      } catch {
        // Runtime shutdown is best effort and idempotent.
      }
    }
    this.registry.clear();
  }

  states(): ReadonlyArray<HerdrMirrorHostState> {
    return HERDR_HOSTS.map((host) => {
      const mirror = this.registry.get(host.id);
      return {
        hostId: host.id,
        fresh: mirror?.isFresh() ?? false,
        lastSyncAt: mirror?.lastSyncAt,
      };
    });
  }
}
