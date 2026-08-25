/**
 * Catching a Muse seat's session id after the fact.
 *
 * A provisioned harness is told its session before the PTY opens; Muse is the
 * other shape — the id exists only once the process is running, and Muse never
 * prints it. So the seat watches for it: on each of its own state boundaries,
 * capture reads Muse's session store for the session started in this seat's
 * workspace after this seat spawned, then writes it to the node so a cold wake
 * can `muse resume <uuid>` instead of starting a fresh session.
 *
 * Once per binding. A seat that already carries an id never looks again, and a
 * seat whose capture landed stops watching — the store walk is cheap, but a
 * repeated write to the canvas is not, and re-capturing after a resume could
 * overwrite a good id with a newer sibling session.
 */

import { captureMuseSessionId, isMuseSessionId } from "./templates/muse-session";
import { writeSeatSessionId } from "./seat-session-id";

type Watch = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly cwd: string;
  readonly spawnedAtMs: number;
  settled: boolean;
};

export class MuseSeatCapture {
  private readonly watching = new Map<string, Watch>();
  private readonly home: () => string;

  constructor(home: () => string) {
    this.home = home;
  }

  /**
   * Start watching a freshly spawned Muse seat. A seat that already has a
   * session id is resuming one and has nothing to capture.
   */
  watch(input: {
    readonly bindingId: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly cwd: string;
    readonly spawnedAtMs: number;
    readonly existingSessionId?: string;
  }): void {
    const existing = input.existingSessionId?.trim();
    if (existing && isMuseSessionId(existing)) return;
    if (!input.canvasName.trim() || !input.nodeId.trim() || !input.cwd.trim()) {
      return;
    }
    this.watching.set(input.bindingId, {
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      cwd: input.cwd,
      spawnedAtMs: input.spawnedAtMs,
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
    const sessionId = captureMuseSessionId({
      cwd: watch.cwd,
      spawnedAtMs: watch.spawnedAtMs,
      home: this.home(),
    });
    // Undefined is the normal early answer: Muse writes its store
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
