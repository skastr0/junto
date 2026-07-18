import { isKnownHerdrHost, listHerdrHosts } from "./hosts";
import { subscribeHostsSnapshot } from "../hosts/snapshot";
import { HerdrMirror } from "./mirror";
import type { MirrorTransport } from "./mirror-transport";

export interface HerdrMirrorHostState {
  readonly hostId: string;
  readonly fresh: boolean;
  readonly lastSyncAt?: number;
}

export class HerdrMirrorRegistry {
  private readonly registry = new Map<string, HerdrMirror>();
  private started = false;
  private unsubscribeHosts?: () => void;

  constructor(private readonly makeTransport: (hostId: string) => MirrorTransport) {}

  mirrorFor(hostId: string): HerdrMirror | undefined {
    if (!isKnownHerdrHost(hostId)) return undefined;
    let mirror = this.registry.get(hostId);
    if (!mirror) {
      mirror = new HerdrMirror(hostId, this.makeTransport(hostId));
      this.registry.set(hostId, mirror);
      if (this.started) mirror.start();
    }
    return mirror;
  }

  startAll(): void {
    if (!this.unsubscribeHosts) {
      this.unsubscribeHosts = subscribeHostsSnapshot(() => this.reconcileHosts());
    }
    this.started = true;
    for (const host of listHerdrHosts()) this.mirrorFor(host.id);
  }

  stopAll(): void {
    this.started = false;
    this.unsubscribeHosts?.();
    this.unsubscribeHosts = undefined;
    for (const mirror of this.registry.values()) {
      try {
        mirror.stop();
      } catch {
        // Runtime shutdown is best effort and idempotent.
      }
    }
    this.registry.clear();
  }

  private reconcileHosts(): void {
    if (!this.started) return;
    // Host mutations are rare and may change an endpoint without changing its
    // stable id. Rebuild every live mirror so no socket/forward can remain
    // attached to an old machine, and removals stop polling immediately.
    for (const mirror of this.registry.values()) {
      try {
        mirror.stop();
      } catch {
        // Reconciliation remains best-effort per mirror.
      }
    }
    this.registry.clear();
    for (const host of listHerdrHosts()) this.mirrorFor(host.id);
  }

  states(): ReadonlyArray<HerdrMirrorHostState> {
    return listHerdrHosts().map((host) => {
      const mirror = this.registry.get(host.id);
      return {
        hostId: host.id,
        fresh: mirror?.isFresh() ?? false,
        lastSyncAt: mirror?.lastSyncAt,
      };
    });
  }
}
