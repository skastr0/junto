import { hostHasCapability, type RemoteHost } from "@shared/remote-hosts";
import { isKnownHerdrHost, listHerdrHosts } from "./hosts";
import { subscribeHostsSnapshot } from "../hosts/snapshot";
import { HerdrMirror } from "./mirror";
import type { MirrorTransport } from "./mirror-transport";
import {
  awaitHerdrPromiseFixedPoint,
  cleanHerdrComponentReceipt,
  herdrComponentReceipt,
  herdrShutdownMessage,
  type HerdrComponentShutdownReceipt,
  type HerdrShutdownCause,
  validateHerdrShutdownTimeout,
} from "./shutdown";

export interface HerdrMirrorHostState {
  readonly hostId: string;
  readonly fresh: boolean;
  readonly lastSyncAt?: number;
}

/**
 * Live herdr-side resources that must be revoked, synchronously with
 * reconciliation, when a host is removed or its endpoint materially changes
 * (a same-id edit is treated as remove+add). Injected so the herdr plane can
 * wire the real stream manager / observe pool / ssh transport while tests
 * fake them.
 */
export interface HerdrHostRevocationHooks {
  /** Detach every live control stream for hostId (release + SIGTERM client only). */
  readonly detachByHost: (hostId: string) => void;
  /** Kill + drop every pooled observer for hostId (retention discarded). */
  readonly releaseByHost: (hostId: string) => void;
  /** Best-effort `-O exit` against the host's OLD shared ControlMaster. */
  readonly teardownEndpoint: (endpoint: string) => void;
}

export class HerdrMirrorRegistry {
  private readonly registry = new Map<string, HerdrMirror>();
  private readonly changeCbs = new Set<(hostId: string) => void>();
  private started = false;
  private shuttingDown = false;
  private unsubscribeHosts?: () => void;
  private readonly activeTransportOperations = new Set<Promise<unknown>>();
  private readonly shutdownDrainTimeoutMs: number;
  private shutdownStopCauses: ReadonlyArray<HerdrShutdownCause> = [];
  private drainFlight: Promise<HerdrComponentShutdownReceipt> | undefined;
  private cleanShutdownReceipt: HerdrComponentShutdownReceipt | undefined;

  constructor(
    private readonly makeTransport: (hostId: string) => MirrorTransport,
    private readonly revocation?: HerdrHostRevocationHooks,
    opts: { readonly shutdownDrainTimeoutMs?: number } = {},
  ) {
    this.shutdownDrainTimeoutMs = validateHerdrShutdownTimeout(
      opts.shutdownDrainTimeoutMs,
      2_000,
    );
  }

  private trackTransportOperation<T>(start: () => Promise<T>): Promise<T> {
    let operation: Promise<T>;
    try {
      operation = Promise.resolve(start());
    } catch (error) {
      operation = Promise.reject(error);
    }
    this.activeTransportOperations.add(operation);
    void operation.then(
      () => this.activeTransportOperations.delete(operation),
      () => this.activeTransportOperations.delete(operation),
    );
    return operation;
  }

  private trackedTransport(transport: MirrorTransport): MirrorTransport {
    return {
      request: (method, params, timeoutMs) =>
        this.trackTransportOperation(() => transport.request(method, params, timeoutMs)),
      openEvents: (subscriptions, onEvent, onClose) =>
        this.trackTransportOperation(() =>
          transport.openEvents(subscriptions, onEvent, onClose),
        ),
      dispose: () => transport.dispose(),
    };
  }

  onChange(cb: (hostId: string) => void): () => void {
    this.changeCbs.add(cb);
    return () => {
      this.changeCbs.delete(cb);
    };
  }

  private notifyChange(hostId: string): void {
    for (const cb of this.changeCbs) {
      try {
        cb(hostId);
      } catch {
        // Listener errors never break registry notification
      }
    }
  }

  mirrorFor(hostId: string): HerdrMirror | undefined {
    if (this.shuttingDown) return undefined;
    if (!isKnownHerdrHost(hostId)) return undefined;
    let mirror = this.registry.get(hostId);
    if (!mirror) {
      mirror = new HerdrMirror(hostId, this.trackedTransport(this.makeTransport(hostId)));
      mirror.onChange(() => this.notifyChange(hostId));
      this.registry.set(hostId, mirror);
      if (this.started) mirror.start();
    }
    return mirror;
  }

  startAll(): void {
    if (this.shuttingDown) return;
    if (!this.unsubscribeHosts) {
      this.unsubscribeHosts = subscribeHostsSnapshot((hosts, previous) =>
        this.reconcileHosts(hosts, previous),
      );
    }
    this.started = true;
    for (const host of listHerdrHosts()) {
      this.mirrorFor(host.id);
      this.notifyChange(host.id);
    }
  }

  stopAll(): HerdrComponentShutdownReceipt {
    return this.beginShutdown();
  }

  /** Synchronously prevent new mirrors/reconciliation, then stop every one. */
  beginShutdown(): HerdrComponentShutdownReceipt {
    if (this.shuttingDown) {
      return this.activeTransportOperations.size === 0 && this.shutdownStopCauses.length === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(
            this.activeTransportOperations.size,
            this.shutdownStopCauses,
          );
    }
    this.shuttingDown = true;
    this.started = false;
    const causes: HerdrShutdownCause[] = [];
    try {
      this.unsubscribeHosts?.();
    } catch (error) {
      causes.push({
        code: "mirror-host-subscription-stop-failed",
        message: herdrShutdownMessage(error),
      });
    }
    this.unsubscribeHosts = undefined;
    for (const mirror of this.registry.values()) {
      try {
        mirror.stop();
      } catch (error) {
        causes.push({
          code: "mirror-stop-failed",
          message: herdrShutdownMessage(error),
        });
      }
    }
    this.registry.clear();
    this.shutdownStopCauses = Object.freeze(causes);
    return causes.length === 0 && this.activeTransportOperations.size === 0
      ? cleanHerdrComponentReceipt()
      : herdrComponentReceipt(this.activeTransportOperations.size, causes);
  }

  drainOnQuit(): Promise<HerdrComponentShutdownReceipt> {
    this.beginShutdown();
    if (this.cleanShutdownReceipt) return Promise.resolve(this.cleanShutdownReceipt);
    if (this.drainFlight) return this.drainFlight;
    const flight = (async (): Promise<HerdrComponentShutdownReceipt> => {
      const settled = await awaitHerdrPromiseFixedPoint(
        () => [...this.activeTransportOperations],
        this.shutdownDrainTimeoutMs,
      );
      const causes = [...this.shutdownStopCauses];
      if (!settled || this.activeTransportOperations.size > 0) {
        causes.push({
          code: "mirror-transport-retained",
          message: `${this.activeTransportOperations.size} mirror transport operation(s) did not settle before shutdown timeout`,
        });
      }
      const receipt = causes.length === 0 && this.activeTransportOperations.size === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(this.activeTransportOperations.size, causes);
      if (receipt.clean) this.cleanShutdownReceipt = receipt;
      return receipt;
    })();
    this.drainFlight = flight;
    void flight.finally(() => {
      if (this.drainFlight === flight) this.drainFlight = undefined;
    });
    return flight;
  }

  /**
   * Herdr-plane resource revocation. Scoped to hosts that HAD herdr
   * capability in `previous`: a host dropped from the document entirely and
   * a host that merely lost herdr capability both mean its live
   * streams/observers/master must go — same as a same-id endpoint edit,
   * which is treated as remove+add (old endpoint torn down, new endpoint
   * dialed fresh by the next mirror/stream/observe attach).
   */
  private revokedHosts(
    hosts: ReadonlyArray<RemoteHost>,
    previous: ReadonlyArray<RemoteHost>,
  ): ReadonlyArray<RemoteHost> {
    const prevHerdr = previous.filter((h) => hostHasCapability(h, "herdr"));
    const currHerdrIds = new Set(
      hosts.filter((h) => hostHasCapability(h, "herdr")).map((h) => h.id),
    );
    return prevHerdr.filter((prevHost) => {
      if (!currHerdrIds.has(prevHost.id)) return true; // removed (or lost herdr capability)
      const currHost = hosts.find((h) => h.id === prevHost.id);
      return currHost?.sshEndpoint !== prevHost.sshEndpoint; // same id, endpoint changed
    });
  }

  private reconcileHosts(
    hosts: ReadonlyArray<RemoteHost>,
    previous: ReadonlyArray<RemoteHost>,
  ): void {
    if (!this.started || this.shuttingDown) return;

    const revoked = this.revokedHosts(hosts, previous);

    // Product-lock order: detach every live control stream, then drop every
    // pooled observer, BEFORE the mirror rebuild and ssh master teardown
    // below — nothing may still be riding a transport this reconciliation
    // is about to tear down. Best-effort per host, matching the mirror-stop
    // loop below: one hook throwing (e.g. a stream emit sink) must not skip
    // revocation for the remaining hosts in this same batch.
    for (const host of revoked) {
      try {
        this.revocation?.detachByHost(host.id);
      } catch {
        // Revocation remains best-effort per host.
      }
    }
    for (const host of revoked) {
      try {
        this.revocation?.releaseByHost(host.id);
      } catch {
        // Revocation remains best-effort per host.
      }
    }

    const previousHostIds = new Set(this.registry.keys());
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
    const currentHosts = listHerdrHosts();
    const currentHostIds = new Set(currentHosts.map((h) => h.id));
    for (const host of currentHosts) {
      this.mirrorFor(host.id);
      this.notifyChange(host.id);
    }
    for (const oldHostId of previousHostIds) {
      if (!currentHostIds.has(oldHostId)) {
        this.notifyChange(oldHostId);
      }
    }

    // Tear down the OLD shared ControlMaster last — after every consumer
    // (control streams, observers, mirror forward) has already released it.
    for (const host of revoked) {
      if (host.kind === "remote" && host.sshEndpoint) {
        this.revocation?.teardownEndpoint(host.sshEndpoint);
      }
    }
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
