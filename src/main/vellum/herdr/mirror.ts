/**
 * Per-host herdr state mirror (phase B). herdr's documented client shape:
 * bootstrap via session.snapshot, then events.subscribe and maintain a local
 * cache, re-snapshot on reconnect/staleness (socket-api docs). Reads answer
 * instantly from local state; when not fresh they return undefined so callers
 * fall back to the exec path. Default session only — named sessions are
 * separate servers and stay on exec.
 *
 * Snapshot field names verified live against `herdr api snapshot` (0.7.3,
 * protocol 16): result.snapshot.{workspaces,tabs,panes,agents,layouts,
 * focused_workspace_id,focused_tab_id,focused_pane_id}; rows keyed by
 * workspace_id / tab_id / pane_id; layouts keyed by workspace_id+tab_id.
 */
import type { MirrorTransport } from "./mirror-transport";

type Rec = Record<string, unknown>;

const asRecord = (value: unknown): Rec | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const recordList = (value: unknown): Rec[] =>
  Array.isArray(value) ? value.map(asRecord).filter((r): r is Rec => r !== undefined) : [];

/** Unscoped lifecycle kinds (from `herdr api schema`, protocol 16). */
const UNSCOPED_KINDS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
] as const;

/** Kinds that change the pane SET → the per-pane subscription list is stale →
 * debounce, then rebuild (close events + fresh snapshot + resubscribe). */
const PANE_SET_KINDS = new Set(["pane.created", "pane.closed", "pane.moved", "pane.exited"]);

const KNOWN_KINDS = new Set<string>([
  ...UNSCOPED_KINDS,
  "pane.agent_status_changed",
  "pane.scroll_changed",
]);

const DEFAULT_BACKOFF_MS = [500, 2_000, 5_000, 15_000] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The read surface HerdrService consumes (tests inject fakes against this). */
export interface HerdrMirrorReads {
  isFresh(): boolean;
  listWorkspaces(): ReadonlyArray<Rec> | undefined;
  listTabs(workspaceId?: string): ReadonlyArray<Rec> | undefined;
  listPanes(workspaceId?: string): ReadonlyArray<Rec> | undefined;
  listAgents(): ReadonlyArray<Rec> | undefined;
  paneRecord(paneId: string): Rec | undefined;
}

export interface HerdrMirrorOpts {
  readonly backoffMs?: ReadonlyArray<number>;
  /** Debounce before rebuilding the events connection after a pane-set change. */
  readonly resubscribeDebounceMs?: number;
  /** onChange coalescing window. */
  readonly changeCoalesceMs?: number;
}

export class HerdrMirror implements HerdrMirrorReads {
  private readonly workspaces = new Map<string, Rec>();
  private readonly tabs = new Map<string, Rec>();
  private readonly panes = new Map<string, Rec>();
  private readonly agents = new Map<string, Rec>();
  private readonly layouts = new Map<string, Rec>();
  private focusedWorkspaceId?: string;
  private focusedTabId?: string;
  private focusedPaneId?: string;

  private bootstrapped = false;
  private eventsLive = false;
  private started = false;
  private stopped = false;
  private connecting = false;
  private closeEventsFn?: () => void;
  private resubTimer?: ReturnType<typeof setTimeout>;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private backoffIdx = 0;
  private readonly changeCbs = new Set<() => void>();

  private readonly backoffMs: ReadonlyArray<number>;
  private readonly resubDebounceMs: number;
  private readonly coalesceMs: number;

  /** Epoch ms of the last successful snapshot+subscribe; undefined until first. */
  lastSyncAt?: number;

  constructor(
    readonly hostId: string,
    private readonly transport: MirrorTransport,
    opts?: HerdrMirrorOpts,
  ) {
    this.backoffMs = opts?.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF_MS;
    this.resubDebounceMs = opts?.resubscribeDebounceMs ?? 500;
    this.coalesceMs = opts?.changeCoalesceMs ?? 100;
  }

  // --- lifecycle -------------------------------------------------------------

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.resubTimer) clearTimeout(this.resubTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.resubTimer = undefined;
    this.changeTimer = undefined;
    this.closeEventsFn?.();
    this.closeEventsFn = undefined;
    this.eventsLive = false;
    this.transport.dispose();
  }

  private nextBackoff(): number {
    const ms = this.backoffMs[Math.min(this.backoffIdx, this.backoffMs.length - 1)] ?? 500;
    this.backoffIdx += 1;
    return ms;
  }

  /** Bootstrap-with-backoff loop. Never throws; freshness just degrades. */
  private async connectLoop(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      while (!this.stopped) {
        if (await this.bootstrap()) return;
        await sleep(this.nextBackoff());
      }
    } finally {
      this.connecting = false;
    }
  }

  /** snapshot → populate → subscribe (documented client shape). */
  private async bootstrap(): Promise<boolean> {
    try {
      const result = await this.transport.request("session.snapshot", {});
      if (this.stopped) return true;
      this.applySnapshot(result);
      const subscriptions: Rec[] = [
        ...UNSCOPED_KINDS.map((type) => ({ type }) as Rec),
        ...[...this.panes.keys()].map(
          (pane_id) => ({ type: "pane.agent_status_changed", pane_id }) as Rec,
        ),
      ];
      const close = await this.transport.openEvents(
        subscriptions,
        (evt) => this.applyEvent(evt),
        (reason) => this.onEventsClosed(reason),
      );
      if (this.stopped) {
        close();
        return true;
      }
      // A pending debounced rebuild (scheduleRebuild) targeted the OLD events
      // connection; firing now would tear down this fresh one. Drop it.
      this.clearResubTimer();
      this.closeEventsFn = close;
      this.eventsLive = true;
      this.backoffIdx = 0;
      this.lastSyncAt = Date.now();
      this.emitChange();
      return true;
    } catch {
      this.eventsLive = false;
      return false;
    }
  }

  private clearResubTimer(): void {
    if (this.resubTimer) clearTimeout(this.resubTimer);
    this.resubTimer = undefined;
  }

  private onEventsClosed(reason: string): void {
    void reason;
    if (this.stopped) return;
    // The connection the pending rebuild meant to replace is already gone;
    // letting the timer fire would close the reconnect's fresh connection.
    this.clearResubTimer();
    this.eventsLive = false;
    this.closeEventsFn = undefined;
    this.emitChange();
    void (async () => {
      await sleep(this.nextBackoff());
      if (!this.stopped) void this.connectLoop();
    })();
  }

  /** Debounced close + re-snapshot + resubscribe (pane-set drift / self-heal). */
  private scheduleRebuild(): void {
    if (this.stopped) return;
    if (this.resubTimer) clearTimeout(this.resubTimer);
    this.resubTimer = setTimeout(() => {
      this.resubTimer = undefined;
      if (this.stopped) return;
      this.eventsLive = false;
      this.closeEventsFn?.(); // deliberate close — no onClose fires
      this.closeEventsFn = undefined;
      this.emitChange(); // freshness flipped — listeners see the stale window
      void this.connectLoop();
    }, this.resubDebounceMs);
  }

  // --- state -----------------------------------------------------------------

  private applySnapshot(result: unknown): void {
    const root = asRecord(result);
    const snapshot = asRecord(root?.snapshot) ?? root ?? {};
    this.workspaces.clear();
    this.tabs.clear();
    this.panes.clear();
    this.agents.clear();
    this.layouts.clear();
    for (const row of recordList(snapshot.workspaces)) {
      const id = str(row.workspace_id);
      if (id) this.workspaces.set(id, row);
    }
    for (const row of recordList(snapshot.tabs)) {
      const id = str(row.tab_id);
      if (id) this.tabs.set(id, row);
    }
    for (const row of recordList(snapshot.panes)) {
      const id = str(row.pane_id);
      if (id) this.panes.set(id, row);
    }
    for (const row of recordList(snapshot.agents)) {
      const id = str(row.pane_id);
      if (id) this.agents.set(id, row);
    }
    for (const row of recordList(snapshot.layouts)) {
      const key = this.layoutKey(row);
      if (key) this.layouts.set(key, row);
    }
    this.focusedWorkspaceId = str(snapshot.focused_workspace_id);
    this.focusedTabId = str(snapshot.focused_tab_id);
    this.focusedPaneId = str(snapshot.focused_pane_id);
    this.bootstrapped = true;
  }

  private layoutKey(row: Rec): string | undefined {
    const ws = str(row.workspace_id);
    const tab = str(row.tab_id);
    return ws && tab ? `${ws}/${tab}` : undefined;
  }

  /** Event body minus the routing `type` key, merged over the nested record
   * when the event nests it (evt.workspace / evt.tab / evt.pane). */
  private eventBody(evt: Rec, nestedKey: string): Rec {
    const { type: _type, ...flat } = evt;
    const nested = asRecord(evt[nestedKey]);
    return nested ? { ...flat, ...nested } : flat;
  }

  private upsert(map: Map<string, Rec>, id: string, body: Rec): void {
    const existing = map.get(id);
    map.set(id, existing ? { ...existing, ...body } : body);
  }

  private applyEvent(evt: Rec): void {
    if (this.stopped) return;
    const kind = str(evt.type) ?? str(evt.kind);
    if (!kind || !KNOWN_KINDS.has(kind)) {
      // Unknown kind: never trust a stale cache silently — self-heal.
      this.scheduleRebuild();
      return;
    }

    if (kind.startsWith("workspace.")) {
      const body = this.eventBody(evt, "workspace");
      const id = str(body.workspace_id);
      if (id) {
        if (kind === "workspace.closed") {
          this.workspaces.delete(id);
        } else if (kind === "workspace.focused") {
          this.focusedWorkspaceId = id;
        } else {
          this.upsert(this.workspaces, id, body);
        }
      }
    } else if (kind.startsWith("tab.")) {
      const body = this.eventBody(evt, "tab");
      const id = str(body.tab_id);
      if (id) {
        if (kind === "tab.closed") {
          this.tabs.delete(id);
        } else if (kind === "tab.focused") {
          this.focusedTabId = id;
        } else {
          this.upsert(this.tabs, id, body);
        }
      }
    } else if (kind.startsWith("pane.")) {
      const body = this.eventBody(evt, "pane");
      const id = str(body.pane_id);
      if (id) {
        if (kind === "pane.closed" || kind === "pane.exited") {
          this.panes.delete(id);
          this.agents.delete(id);
        } else if (kind === "pane.focused") {
          this.focusedPaneId = id;
        } else if (kind === "pane.agent_status_changed") {
          const status = str(body.agent_status) ?? str(body.status);
          const patch = status ? { ...body, agent_status: status } : body;
          this.upsert(this.panes, id, patch);
          if (this.agents.has(id)) this.upsert(this.agents, id, patch);
        } else {
          this.upsert(this.panes, id, body);
          if (kind === "pane.agent_detected" || str(body.agent)) {
            this.upsert(this.agents, id, this.panes.get(id) ?? body);
          }
        }
      }
      if (PANE_SET_KINDS.has(kind)) this.scheduleRebuild();
    } else if (kind === "layout.updated") {
      const body = this.eventBody(evt, "layout");
      const key = this.layoutKey(body);
      if (key) this.layouts.set(key, body);
    }
    // worktree.* / pane.scroll_changed: known, no mirrored state — ignore.

    this.emitChange();
  }

  // --- reads (undefined when not fresh → caller falls back to exec) ----------

  isFresh(): boolean {
    return this.bootstrapped && this.eventsLive && !this.stopped;
  }

  listWorkspaces(): ReadonlyArray<Rec> | undefined {
    return this.isFresh() ? [...this.workspaces.values()] : undefined;
  }

  listTabs(workspaceId?: string): ReadonlyArray<Rec> | undefined {
    if (!this.isFresh()) return undefined;
    const all = [...this.tabs.values()];
    return workspaceId ? all.filter((t) => str(t.workspace_id) === workspaceId) : all;
  }

  listPanes(workspaceId?: string): ReadonlyArray<Rec> | undefined {
    if (!this.isFresh()) return undefined;
    const all = [...this.panes.values()];
    return workspaceId ? all.filter((p) => str(p.workspace_id) === workspaceId) : all;
  }

  listAgents(): ReadonlyArray<Rec> | undefined {
    return this.isFresh() ? [...this.agents.values()] : undefined;
  }

  paneRecord(paneId: string): Rec | undefined {
    return this.isFresh() ? this.panes.get(paneId) : undefined;
  }

  focused(): {
    readonly workspaceId?: string;
    readonly tabId?: string;
    readonly paneId?: string;
  } {
    return {
      workspaceId: this.focusedWorkspaceId,
      tabId: this.focusedTabId,
      paneId: this.focusedPaneId,
    };
  }

  // --- change push (coalesced) -----------------------------------------------

  onChange(cb: () => void): () => void {
    this.changeCbs.add(cb);
    return () => {
      this.changeCbs.delete(cb);
    };
  }

  private emitChange(): void {
    if (this.changeTimer) return; // coalesce bursts
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      for (const cb of this.changeCbs) {
        try {
          cb();
        } catch {
          // listener errors never break the mirror
        }
      }
    }, this.coalesceMs);
  }
}
