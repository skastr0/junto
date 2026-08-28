/**
 * Catching a seat's session id after the fact.
 *
 * A provisioned harness (Amp) is told its session before the PTY opens. Muse,
 * fx and Oh My Pi are the other shape: the id exists only once the process is running,
 * and neither prints it. So the seat watches for it — on each of its own state
 * boundaries, capture reads the harness's session store for the session started
 * in this seat's workspace after this seat spawned, then writes it to the node
 * so a cold wake resumes that exact session instead of starting a fresh one.
 *
 * Once per binding. A seat that already carries an id never looks again, and a
 * seat whose capture landed stops watching — the store walk is cheap, but a
 * repeated write to the canvas is not, and re-capturing after a resume could
 * overwrite a good id with a newer sibling session.
 */

import { captureMuseSessionId, isMuseSessionId } from "./templates/muse-session";
import { discoverFxSessionId, isFxSessionId } from "./templates/fx-session";
import { discoverOmpSessionId, isOmpSessionId } from "./templates/omp-session";
import { writeSeatSessionId } from "./seat-session-id";

/** How a harness reveals the id it minted, and how to tell one when seen. */
export type SessionDiscovery = {
  readonly discover: (input: {
    readonly cwd: string;
    readonly spawnedAtMs: number;
    readonly home: string;
  }) => string | undefined;
  readonly isSessionId: (value: string) => boolean;
};

const DISCOVERY: Readonly<Record<string, SessionDiscovery>> = {
  muse: { discover: captureMuseSessionId, isSessionId: isMuseSessionId },
  fx: { discover: discoverFxSessionId, isSessionId: isFxSessionId },
  omp: { discover: discoverOmpSessionId, isSessionId: isOmpSessionId },
};

/** Harnesses whose id is found after the fact rather than pinned or minted. */
export const discoversSessionAfterSpawn = (harness: string): boolean =>
  Object.hasOwn(DISCOVERY, harness);

type Watch = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly cwd: string;
  readonly spawnedAtMs: number;
  readonly discovery: SessionDiscovery;
  settled: boolean;
};

export class SeatSessionCapture {
  private readonly watching = new Map<string, Watch>();
  private readonly home: () => string;

  constructor(home: () => string) {
    this.home = home;
  }

  /**
   * Start watching a freshly spawned seat. A seat that already has a session id
   * is resuming one and has nothing to capture, and a harness that pins or
   * provisions its id is not watched at all.
   */
  watch(input: {
    readonly bindingId: string;
    readonly harness: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly cwd: string;
    readonly spawnedAtMs: number;
    readonly existingSessionId?: string;
  }): void {
    const discovery = DISCOVERY[input.harness];
    if (!discovery) return;
    const existing = input.existingSessionId?.trim();
    if (existing && discovery.isSessionId(existing)) return;
    if (!input.canvasName.trim() || !input.nodeId.trim() || !input.cwd.trim()) {
      return;
    }
    this.watching.set(input.bindingId, {
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      cwd: input.cwd,
      spawnedAtMs: input.spawnedAtMs,
      discovery,
      settled: false,
    });
  }

  /** Stop watching (seat gone, or its generation was replaced). */
  forget(bindingId: string): void {
    this.watching.delete(bindingId);
  }

  /**
   * Try once for this binding. Returns the captured id when this call is the
   * one that found and stored it, so a caller can log the transition.
   */
  async attempt(bindingId: string): Promise<string | undefined> {
    const watch = this.watching.get(bindingId);
    if (!watch || watch.settled) return undefined;
    const sessionId = watch.discovery.discover({
      cwd: watch.cwd,
      spawnedAtMs: watch.spawnedAtMs,
      home: this.home(),
    });
    // Undefined is the normal early answer: these harnesses write their store
    // asynchronously, so the next boundary tries again.
    if (sessionId === undefined) return undefined;
    // Claim the slot before awaiting, so two boundaries arriving together
    // cannot both write.
    watch.settled = true;
    const stored = await writeSeatSessionId({
      canvasName: watch.canvasName,
      nodeId: watch.nodeId,
      sessionId,
      // A resuming seat already carries its id; capture must not replace it
      // with a sibling session that happens to be newer in the store.
      onlyIfAbsent: true,
    });
    if (!stored.ok) {
      // Keep watching: an unwritten id means the seat still cannot cold-resume,
      // and the next boundary is a free retry.
      watch.settled = false;
      return undefined;
    }
    this.watching.delete(bindingId);
    return sessionId;
  }

  /** Bindings still waiting for their id (diagnostics / tests). */
  pending(): readonly string[] {
    return [...this.watching.keys()];
  }
}
