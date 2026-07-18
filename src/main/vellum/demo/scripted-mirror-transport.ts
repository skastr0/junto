/**
 * In-memory MirrorTransport for the demo/scripting engine. Stands in for a
 * real herdr socket so a real HerdrMirror (unchanged) drives the real
 * herdr -> IPC -> renderer pipeline off a scripted world instead of a live
 * herdr server.
 *
 * Wire shape is the exact snake_case fixture herdr ships (verified against
 * tests/herdr-mirror.test.ts:29 snapshotFixture / `herdr api snapshot`
 * 0.7.3, protocol 16): result.snapshot.{workspaces,tabs,panes,agents,
 * layouts,focused_workspace_id,focused_tab_id,focused_pane_id}. Lifecycle
 * events mirror.ts applies are `{ event: "<snake>_created", data: { type,
 * <entity>: {...} } }`; the subscribed status event is dotted and flat:
 * `{ event: "pane.agent_status_changed", data: { pane_id, agent_status } }`
 * (see event-normalize.ts + tests/herdr-mirror.test.ts:153+).
 *
 * Single fixed workspace "w1" / tab "w1:t1" — the demo world never needs
 * more than one board. Every pane spec ensured onto a given transport lands
 * in that tab.
 */
import type { DemoHerdrPaneSpec, DemoHerdrStatus } from "@shared/demo";
import type { MirrorTransport } from "../herdr/mirror-transport";

type Rec = Record<string, unknown>;

const WORKSPACE_ID = "w1";
const TAB_ID = "w1:t1";
const LAYOUT_KEY = `${WORKSPACE_ID}/${TAB_ID}`;

type MirrorHandlers = {
  readonly onEvent: (evt: Rec) => void;
  readonly onClose: (reason: string) => void;
};

export class ScriptedMirrorTransport implements MirrorTransport {
  private readonly workspaces = new Map<string, Rec>();
  private readonly tabs = new Map<string, Rec>();
  private readonly panes = new Map<string, Rec>();
  private readonly agents = new Map<string, Rec>();
  private readonly layouts = new Map<string, Rec>();
  private focusedWorkspaceId: string | undefined;
  private focusedTabId: string | undefined;
  private focusedPaneId: string | undefined;

  private handlers: MirrorHandlers | undefined;

  // --- MirrorTransport --------------------------------------------------

  async request(method: string, _params: unknown, _timeoutMs?: number): Promise<unknown> {
    if (method === "session.snapshot") return this.snapshot();
    // Only session.snapshot is exercised by HerdrMirror; any other method
    // (a future addition) gets a benign empty result rather than a throw —
    // the scripted world has nothing else to answer with.
    return {};
  }

  async openEvents(
    _subscriptions: ReadonlyArray<Record<string, unknown>>,
    onEvent: (evt: Rec) => void,
    onClose: (reason: string) => void,
  ): Promise<() => void> {
    // Resubscribe (post pane-set-change rebuild) replaces the prior
    // handlers — only the latest subscription is ever live.
    this.handlers = { onEvent, onClose };
    return () => {
      this.handlers = undefined;
    };
  }

  dispose(): void {
    // No persistent connection — nothing to tear down beyond handlers,
    // which the openEvents closer already clears on deliberate close.
  }

  // --- mutation API (conductor -> scripted world) ------------------------

  /** Create workspace/tab/pane/agent records if missing; idempotent. When
   * the pane already exists, `status` (if given) is applied via setStatus
   * instead of re-creating it. */
  ensurePane(spec: DemoHerdrPaneSpec, status: DemoHerdrStatus = "idle"): void {
    let createdWorkspace = false;
    let createdTab = false;

    if (!this.workspaces.has(WORKSPACE_ID)) {
      this.workspaces.set(WORKSPACE_ID, {
        workspace_id: WORKSPACE_ID,
        label: "demo",
        tab_count: 0,
        pane_count: 0,
        agent_status: "idle",
        focused: true,
        number: 1,
      });
      createdWorkspace = true;
    }

    if (!this.tabs.has(TAB_ID)) {
      this.tabs.set(TAB_ID, {
        tab_id: TAB_ID,
        workspace_id: WORKSPACE_ID,
        label: "1",
        pane_count: 0,
        agent_status: "idle",
        focused: true,
        number: 1,
      });
      this.bumpWorkspaceTabCount();
      createdTab = true;
    }

    if (!this.layouts.has(LAYOUT_KEY)) {
      this.layouts.set(LAYOUT_KEY, {
        workspace_id: WORKSPACE_ID,
        tab_id: TAB_ID,
        panes: [],
        splits: [],
        zoomed: false,
      });
    }

    this.focusedWorkspaceId ??= WORKSPACE_ID;
    this.focusedTabId ??= TAB_ID;

    const existingPane = this.panes.has(spec.paneId);
    if (!existingPane) {
      const terminalId = `term-${spec.paneId.replaceAll(":", "-")}`;
      const paneRow: Rec = {
        pane_id: spec.paneId,
        workspace_id: WORKSPACE_ID,
        tab_id: TAB_ID,
        terminal_id: terminalId,
        cwd: spec.cwd,
        foreground_cwd: spec.cwd,
        agent: spec.agent,
        agent_status: status,
        label: spec.label,
        focused: false,
        revision: 0,
      };
      this.panes.set(spec.paneId, paneRow);
      this.agents.set(spec.paneId, {
        pane_id: spec.paneId,
        workspace_id: WORKSPACE_ID,
        tab_id: TAB_ID,
        terminal_id: terminalId,
        cwd: spec.cwd,
        agent: spec.agent,
        agent_status: status,
        focused: false,
      });
      this.bumpTabPaneCount();
    }

    if (createdWorkspace) {
      this.emit({
        event: "workspace_created",
        data: { type: "workspace_created", workspace: this.workspaces.get(WORKSPACE_ID) },
      });
    }
    if (createdTab) {
      this.emit({
        event: "tab_created",
        data: { type: "tab_created", tab: this.tabs.get(TAB_ID) },
      });
    }
    if (!existingPane) {
      this.emit({
        event: "pane_created",
        data: { type: "pane_created", pane: this.panes.get(spec.paneId) },
      });
    } else {
      this.setStatus(spec.paneId, status);
    }
  }

  /** Patches agent_status on an existing pane/agent row and emits the
   * subscribed status event. Returns false (no-op) when the pane is unknown. */
  setStatus(paneId: string, status: DemoHerdrStatus): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    this.panes.set(paneId, { ...pane, agent_status: status });
    const agent = this.agents.get(paneId);
    if (agent) this.agents.set(paneId, { ...agent, agent_status: status });
    this.emit({
      event: "pane.agent_status_changed",
      data: { pane_id: paneId, workspace_id: pane.workspace_id, agent_status: status },
    });
    return true;
  }

  /** Empties the host back to an empty-but-valid snapshot. An unknown-kind
   * event is the mirror's own self-heal trigger (mirror.ts: unrecognized
   * kinds schedule a full close + re-snapshot + resubscribe), so the mirror
   * resyncs onto the now-empty world instead of needing a bespoke reset
   * event kind of our own. */
  resetHost(): void {
    this.workspaces.clear();
    this.tabs.clear();
    this.panes.clear();
    this.agents.clear();
    this.layouts.clear();
    this.focusedWorkspaceId = undefined;
    this.focusedTabId = undefined;
    this.focusedPaneId = undefined;
    this.emit({ event: "demo.host_reset", data: {} });
  }

  // --- internals ----------------------------------------------------------

  private emit(evt: Rec): void {
    this.handlers?.onEvent(evt);
  }

  private bumpWorkspaceTabCount(): void {
    const ws = this.workspaces.get(WORKSPACE_ID);
    if (!ws) return;
    const tabCount = typeof ws.tab_count === "number" ? ws.tab_count : 0;
    this.workspaces.set(WORKSPACE_ID, { ...ws, tab_count: tabCount + 1 });
  }

  private bumpTabPaneCount(): void {
    const tab = this.tabs.get(TAB_ID);
    if (tab) {
      const paneCount = typeof tab.pane_count === "number" ? tab.pane_count : 0;
      this.tabs.set(TAB_ID, { ...tab, pane_count: paneCount + 1 });
    }
    const ws = this.workspaces.get(WORKSPACE_ID);
    if (ws) {
      const paneCount = typeof ws.pane_count === "number" ? ws.pane_count : 0;
      this.workspaces.set(WORKSPACE_ID, { ...ws, pane_count: paneCount + 1 });
    }
  }

  private snapshot(): Rec {
    const raw = {
      snapshot: {
        workspaces: [...this.workspaces.values()],
        tabs: [...this.tabs.values()],
        panes: [...this.panes.values()],
        agents: [...this.agents.values()],
        layouts: [...this.layouts.values()],
        focused_workspace_id: this.focusedWorkspaceId,
        focused_tab_id: this.focusedTabId,
        focused_pane_id: this.focusedPaneId,
        protocol: 16,
        version: "demo",
      },
    };
    // Deep copy — request() callers must never see live map contents that
    // later mutate out from under an already-returned snapshot.
    return JSON.parse(JSON.stringify(raw)) as Rec;
  }
}
