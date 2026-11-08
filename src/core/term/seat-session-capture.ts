/**
 * Catching a seat's session id after the fact.
 *
 * A provisioned harness (Amp) is told its session before the PTY opens. Codex,
 * Muse, fx and Oh My Pi are the other shape: the id exists only once the process is running,
 * and neither prints it. So the seat watches for it — on each of its own state
 * boundaries, capture reads the harness's session store for the session started
 * in this seat's workspace after this seat spawned, then writes it to the node
 * so a cold wake resumes that exact session instead of starting a fresh one.
 * Where the harness keeps its session file open (Codex), the file the seat's
 * own process holds is the answer, so two seats in one folder each get theirs.
 *
 * Once per binding. A seat that already carries an id never looks again, and a
 * seat whose capture landed stops watching — the store walk is cheap, but a
 * repeated write to the canvas is not, and re-capturing after a resume could
 * overwrite a good id with a newer sibling session.
 */

import { sessionStoreFor } from "./session-existence";
import { writeSeatSessionId } from "./seat-session-id";
import { openFilesOfProcessTree, type OpenFilesOf } from "./process-open-files";
import { discoverSpawnedSession, type SpawnedSessionStore } from "./templates/spawned-session";

/**
 * How a harness reveals the id it minted: its session store's spawned block.
 * Codex prints its thread id nowhere in the TUI; PTY scraping only ever
 * caught it from hook or notify echoes, which a plain seat never shows.
 */
const spawnedStoreFor = (harness: string): SpawnedSessionStore | undefined =>
  sessionStoreFor(harness)?.spawned;

/** Harnesses whose id is found after the fact rather than pinned or minted. */
export const discoversSessionAfterSpawn = (harness: string): boolean =>
  spawnedStoreFor(harness) !== undefined;

type Watch = {
  readonly harness: string;
  readonly home: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly cwd: string;
  readonly spawnedAtMs: number;
  /** The seat's own process, when it runs on this machine and has named its pid. */
  readonly pid?: () => number | undefined;
  readonly discovery: SpawnedSessionStore;
  /** Sessions still running in this workspace that belong to no fresh seat. */
  readonly exclude: ReadonlySet<string>;
  settled: boolean;
  /** The session this watch has claimed, which no sibling may take. */
  claimed?: string;
  inFlight?: Promise<string | undefined>;
};

export class SeatSessionCapture {
  private readonly watching = new Map<string, Watch>();
  // A completed/forgotten watcher must not make its session available to a
  // sibling. The durable writer also checks the whole current portfolio.
  private readonly owners = new Map<string, Watch>();
  private readonly home: () => string;
  private readonly openFiles: OpenFilesOf;

  constructor(home: () => string, openFiles: OpenFilesOf = openFilesOfProcessTree) {
    this.home = home;
    this.openFiles = openFiles;
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
    /**
     * The seat's process on this machine; its open files name its session.
     * Read at each look: a PTY in the terminal process names its pid a turn
     * after the spawn is announced.
     */
    readonly pid?: () => number | undefined;
    readonly existingSessionId?: string;
    /**
     * Session ids this seat must never take: its own earlier sessions that
     * are still winding down after an offboard. Such a process keeps writing
     * its session file in the same working directory, so workspace and start
     * time alone can name the wrong one.
     */
    readonly excludeSessionIds?: ReadonlyArray<string>;
  }): void {
    const discovery = spawnedStoreFor(input.harness);
    if (!discovery) return;
    const existing = input.existingSessionId?.trim();
    if (existing && discovery.isSessionId(existing)) return;
    if (!input.canvasName.trim() || !input.nodeId.trim() || !input.cwd.trim()) {
      return;
    }
    this.watching.set(input.bindingId, {
      harness: input.harness,
      home: this.home(),
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      cwd: input.cwd,
      spawnedAtMs: input.spawnedAtMs,
      ...(input.pid === undefined ? {} : { pid: input.pid }),
      discovery,
      exclude: new Set(
        (input.excludeSessionIds ?? [])
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
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
    // Boundaries arrive faster than a process's open files can be listed:
    // one look at a time, and a caller arriving meanwhile shares its answer.
    if (watch.inFlight) return watch.inFlight;
    const look = this.look(bindingId, watch).finally(() => {
      if (watch.inFlight === look) delete watch.inFlight;
    });
    watch.inFlight = look;
    return look;
  }

  /** The sessions this process holds open, or undefined when it cannot be told. */
  private async heldBy(watch: Watch): Promise<ReadonlySet<string> | undefined> {
    const heldSessionId = watch.discovery.heldSessionId;
    const pid = watch.pid?.();
    if (heldSessionId === undefined || pid === undefined) return undefined;
    const files = await this.openFiles(pid).catch(() => undefined);
    if (files === undefined) return undefined;
    const ids = new Set<string>();
    for (const file of files) {
      const id = heldSessionId(file, watch.home);
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  /**
   * What the processes say: the sessions this seat's process holds open, and
   * those its siblings' processes hold. Undefined when this seat's cannot be
   * asked.
   */
  private async held(
    watch: Watch,
  ): Promise<{ readonly mine: ReadonlySet<string>; readonly siblings: ReadonlySet<string> } | undefined> {
    const siblings = [...this.watching.values()].filter(
      (other) => other !== watch && other.harness === watch.harness && other.home === watch.home,
    );
    const [mine, ...theirs] = await Promise.all([watch, ...siblings].map((one) => this.heldBy(one)));
    if (mine === undefined) return undefined;
    return { mine, siblings: new Set(theirs.flatMap((ids) => [...(ids ?? [])])) };
  }

  private async look(bindingId: string, watch: Watch): Promise<string | undefined> {
    // A session another seat here has claimed is never this one's; leaving
    // it in would leave the earliest pick on it for good.
    const exclude = new Set(watch.exclude);
    for (const owner of this.owners.values()) {
      if (owner === watch || owner.home !== watch.home || owner.harness !== watch.harness) continue;
      if (owner.claimed !== undefined) exclude.add(owner.claimed);
    }
    // Asked only where there is a process to ask: otherwise the look stays
    // synchronous up to the write, as it always was.
    const askProcess = watch.discovery.heldSessionId !== undefined && watch.pid?.() !== undefined;
    const held = askProcess ? await this.held(watch) : undefined;
    if (this.watching.get(bindingId) !== watch || watch.settled) return undefined;
    // A file the seat's own process holds settles it. Holding none yet (a
    // Codex before its first turn, or one that closes its file), it still
    // never takes a file a sibling's process holds, and the pick by workspace
    // and time decides among the rest.
    const decisive = held !== undefined && held.mine.size > 0;
    for (const id of held?.siblings ?? []) exclude.add(id);
    const sessionId = discoverSpawnedSession(watch.discovery, {
      cwd: watch.cwd,
      spawnedAtMs: watch.spawnedAtMs,
      home: watch.home,
      exclude,
      ...(decisive ? { only: held.mine } : {}),
    });
    // Undefined is the normal early answer: these harnesses write their store
    // asynchronously, so the next boundary tries again.
    if (sessionId === undefined) return undefined;
    // Whatever a discovery does with `exclude`, an excluded id is never taken.
    if (exclude.has(sessionId)) return undefined;
    const candidateKey = JSON.stringify([watch.home, watch.harness, sessionId]);
    const owner = this.owners.get(candidateKey);
    if (owner !== undefined && owner !== watch) return undefined;
    // The file the seat's own process holds open settles it; only a pick by
    // workspace and time has to make way for a sibling that could claim it.
    if (owner === undefined && !decisive) {
      // One candidate does not mean one eligible seat. Do not choose whichever
      // callback happens first while another watch can claim the same id.
      for (const other of this.watching.values()) {
        if (other === watch || other.harness !== watch.harness || other.home !== watch.home) continue;
        if (discoverSpawnedSession(other.discovery, {
          cwd: other.cwd,
          spawnedAtMs: other.spawnedAtMs,
          home: other.home,
          exclude: other.exclude,
        }) === sessionId) return undefined;
      }
    }
    if (owner === undefined) {
      this.owners.set(candidateKey, watch);
      watch.claimed = sessionId;
    }
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
      capture: {
        bindingId,
        harness: watch.harness,
        isCurrent: () => this.watching.get(bindingId) === watch,
      },
    });
    // An old completion cannot consume a replacement generation's watcher.
    if (this.watching.get(bindingId) !== watch) return undefined;
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
