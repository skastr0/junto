import { useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { EtherHerdr } from "@shared/canvas";
import type {
  HerdrHostInfo,
  HerdrPaneInfo,
  HerdrSessionInfo,
  HerdrTabInfo,
  HerdrWorkspaceInfo,
} from "@shared/ipc";
import { makeHerdrNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import {
  closeHerdrWizard,
  herdr$,
  isHerdrWizardEpochCurrent,
  setHerdrToast,
} from "../../lib/herdr-state";
import { bootstrapHerdrWizard, type HerdrWizardApi, type HerdrWizardStep } from "../../lib/herdr-wizard-seed";
import {
  fetchHerdrPanes,
  fetchHerdrSessions,
  fetchHerdrTabs,
  fetchHerdrWorkspaces,
  invalidateHerdrBrowse,
  peekHerdrBrowse,
  subscribeHerdrBrowseInvalidation,
  type HerdrBrowseFetch,
} from "../../lib/herdr-browse";
import {
  initialHerdrPickGuard,
  pickFromClick as decidePickFromClick,
  pickFromPointer as decidePickFromPointer,
  type HerdrPickGuardState,
} from "../../lib/herdr-pick-guard";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { HUE } from "../../lib/theme";
import { ActivityMark } from "../ActivityMark";

type Step = HerdrWizardStep;

const api = () =>
  getVellumCommandApi() as
    | (ReturnType<typeof getVellumCommandApi> & {
        herdrHosts: () => Promise<ReadonlyArray<HerdrHostInfo>>;
        herdrEnsureServer: (
          hostId: string,
          session?: string | null,
        ) => Promise<{ ok: boolean; message?: string }>;
        herdrListSessions: (
          hostId: string,
        ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrSessionInfo>; message?: string }>;
        herdrListWorkspaces: (
          hostId: string,
          session?: string | null,
        ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrWorkspaceInfo>; message?: string }>;
        herdrListTabs: (
          hostId: string,
          session?: string | null,
          workspaceId?: string,
        ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrTabInfo>; message?: string }>;
        herdrListPanes: (
          hostId: string,
          session?: string | null,
          workspaceId?: string,
        ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrPaneInfo>; message?: string }>;
        herdrCreateWorkspace: (
          hostId: string,
          session: string | null | undefined,
          input: { cwd: string; label?: string },
        ) => Promise<{
          ok: boolean;
          data?: { workspaceId: string; tabId?: string; paneId?: string; terminalId?: string };
          message?: string;
        }>;
        herdrCreateTab: (
          hostId: string,
          session: string | null | undefined,
          input: { workspaceId: string; label?: string },
        ) => Promise<{
          ok: boolean;
          data?: { tabId: string; paneId?: string; terminalId?: string };
          message?: string;
        }>;
        herdrCreatePane: (
          hostId: string,
          session: string | null | undefined,
          input: { paneId?: string; direction?: "right" | "down"; cwd?: string },
        ) => Promise<{
          ok: boolean;
          data?: { paneId: string; terminalId?: string; tabId?: string; workspaceId?: string };
          message?: string;
        }>;
      })
    | undefined;

export function HerdrWizard() {
  const open = use$(herdr$.wizardOpen);
  const anchor = use$(herdr$.wizardAnchor);
  const seed = use$(herdr$.wizardSeed);
  const epochRef = useRef(0);
  // Bumps on every step navigation so a superseded step's in-flight fetch
  // cannot stomp the current step's rows (epoch guards only across open/close).
  const stepTokenRef = useRef(0);
  // Coalesce pointerdown+click and rapid double-selection of the same row.
  const pickGuardRef = useRef<HerdrPickGuardState>(initialHerdrPickGuard);
  const [step, setStep] = useState<Step>("host");
  const [error, setError] = useState("");
  /** A foreground list fetch (cache miss) is in flight — drives the ActivityMark. */
  const [loading, setLoading] = useState(false);
  /** A create mutation is in flight — disables the create button only. */
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [hosts, setHosts] = useState<ReadonlyArray<HerdrHostInfo>>([]);
  const [sessions, setSessions] = useState<ReadonlyArray<HerdrSessionInfo>>([]);
  const [workspaces, setWorkspaces] = useState<ReadonlyArray<HerdrWorkspaceInfo>>([]);
  const [tabs, setTabs] = useState<ReadonlyArray<HerdrTabInfo>>([]);
  const [panes, setPanes] = useState<ReadonlyArray<HerdrPaneInfo>>([]);
  const [hostId, setHostId] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tabId, setTabId] = useState("");
  const [createCwd, setCreateCwd] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  /** True when region defaults pre-filled layers (escape: ignore region defaults). */
  const [seedApplied, setSeedApplied] = useState(false);

  const stillOpen = (): boolean => isHerdrWizardEpochCurrent(epochRef.current);
  // Re-run bootstrap when epoch bumps while open (re-open without close).
  const wizardEpoch = use$(herdr$.wizardEpoch);

  useEffect(() => {
    if (!open) return;
    // Ensure pushed mirror "change" events refresh any open step (idempotent).
    subscribeHerdrBrowseInvalidation();
    epochRef.current = herdr$.wizardEpoch.peek();
    stepTokenRef.current = 0;
    pickGuardRef.current = initialHerdrPickGuard;
    setStep("host");
    setError("");
    setFilter("");
    setHostId("");
    setSession(null);
    setWorkspaceId("");
    setTabId("");
    setCreateCwd("");
    setCreateLabel("");
    // Critical: successful create closes the wizard while creating=true; the
    // component stays mounted (return null when !open). Without this reset the
    // next open leaves "create tab/pane" permanently disabled.
    setCreating(false);
    setSeedApplied(false);
    setLoading(true);

    const applySnapshot = (snap: Awaited<ReturnType<typeof bootstrapHerdrWizard>>) => {
      if (!stillOpen()) return;
      setHosts(snap.hosts);
      setSessions(snap.sessions);
      setWorkspaces(snap.workspaces);
      setTabs(snap.tabs);
      setPanes(snap.panes);
      setHostId(snap.hostId);
      setSession(snap.session);
      setWorkspaceId(snap.workspaceId);
      setTabId(snap.tabId);
      setStep(snap.step);
      setSeedApplied(snap.seedApplied);
      if (snap.error) setError(snap.error);
    };

    const run = async () => {
      const a = api();
      if (!a?.herdrHosts) {
        if (stillOpen()) {
          setError("herdr API unavailable");
          setLoading(false);
        }
        return;
      }
      try {
        const snap = await bootstrapHerdrWizard(
          a as HerdrWizardApi,
          herdr$.wizardSeed.peek(),
        );
        applySnapshot(snap);
      } catch (e) {
        if (stillOpen()) setError(String(e));
      } finally {
        if (stillOpen()) setLoading(false);
      }
    };

    void run();
  }, [open, wizardEpoch]);

  /** Escape hatch: drop region seed and restart full wizard at host. */
  const ignoreRegionDefaults = () => {
    stepTokenRef.current += 1;
    herdr$.wizardSeed.set(null);
    setSeedApplied(false);
    setStep("host");
    setError("");
    setFilter("");
    setHostId("");
    setSession(null);
    setWorkspaceId("");
    setTabId("");
    setSessions([]);
    setWorkspaces([]);
    setTabs([]);
    setPanes([]);
    setLoading(false);
  };

  const needle = filter.trim().toLowerCase();

  const rows = useMemo(() => {
    if (step === "host") {
      return hosts
        .filter((h) => !needle || h.id.includes(needle) || h.label.toLowerCase().includes(needle))
        .map((h) => ({ key: h.id, label: h.label, sub: h.id, onPick: () => void pickHost(h.id) }));
    }
    if (step === "session") {
      const listed = sessions.map((s) => ({
        key: s.name,
        label: s.name,
        sub: s.running ? "running" : s.default ? "default" : "session",
        onPick: () => void pickSession(s.name === "default" ? null : s.name),
      }));
      return [
        { key: "__default", label: "default", sub: "unnamed session", onPick: () => void pickSession(null) },
        ...listed.filter((r) => r.key !== "default"),
      ].filter((r) => !needle || r.label.toLowerCase().includes(needle));
    }
    if (step === "workspace") {
      return workspaces
        .filter((w) => !needle || w.label?.toLowerCase().includes(needle) || w.workspaceId.includes(needle))
        .map((w) => ({
          key: w.workspaceId,
          label: w.label || w.workspaceId,
          sub: `${w.workspaceId}${w.paneCount != null ? ` - ${w.paneCount} panes` : ""}`,
          onPick: () => void pickWorkspace(w.workspaceId),
        }));
    }
    if (step === "tab") {
      return tabs
        .filter((t) => !needle || t.label?.toLowerCase().includes(needle) || t.tabId.includes(needle))
        .map((t) => ({
          key: t.tabId,
          label: t.label || t.tabId,
          sub: `${t.tabId}${t.agentStatus ? ` - ${t.agentStatus}` : ""}`,
          onPick: () => void pickTab(t.tabId),
        }));
    }
    return panes
      .filter(
        (p) =>
          !needle ||
          p.paneId.includes(needle) ||
          p.cwd?.toLowerCase().includes(needle) ||
          p.agent?.toLowerCase().includes(needle) ||
          false,
      )
      .map((p) => ({
        key: p.paneId,
        label: p.agent ? `${p.agent} - ${p.paneId}` : p.paneId,
        sub: [p.cwd, p.agentStatus].filter(Boolean).join(" - "),
        onPick: () => void pickPane(p),
      }));
  }, [step, hosts, sessions, workspaces, tabs, panes, needle]);

  if (!open) return null;

  // Panes are listed per workspace; scope to the picked tab at display time.
  const scopePanes = (rows: ReadonlyArray<HerdrPaneInfo>, id: string): ReadonlyArray<HerdrPaneInfo> => {
    const scoped = rows.filter((p) => !p.tabId || p.tabId === id);
    return scoped.length > 0 ? scoped : rows;
  };

  // Rows advance on pointerdown (press, not release). Because advancing swaps
  // the list to the next step, the trailing click of that same mouse press would
  // otherwise land on a *different* row — so it is suppressed. A keyboard-driven
  // click (no preceding pointerdown) still runs; see herdr-pick-guard.ts.
  type PickDecider = typeof decidePickFromPointer;
  const applyPick = (decide: PickDecider, key: string, run: () => void) => {
    const d = decide(pickGuardRef.current, key, Date.now());
    pickGuardRef.current = d.state;
    if (d.run) run();
  };

  // Stale-while-revalidate load for a step: paint cached rows this frame, kick a
  // background/foreground refresh, and only surface an error when nothing shows.
  // `from` is the originating step: a cold-cache fetch that fails would otherwise
  // strand the wizard on an empty step with no visible list and only "cancel" to
  // recover, so on that path we revert to `from` (whose rows are still in state)
  // and surface the error there — the user can retry by re-picking.
  const loadStep = <T,>(cfg: {
    readonly from: Step;
    readonly peek: () => ReadonlyArray<T> | undefined;
    readonly fetch: (onUpdate: (rows: ReadonlyArray<T>) => void) => Promise<HerdrBrowseFetch<T>>;
    readonly setRows: (rows: ReadonlyArray<T>) => void;
  }): void => {
    const token = (stepTokenRef.current += 1);
    const live = () => stillOpen() && stepTokenRef.current === token;
    const cached = cfg.peek();
    if (cached) {
      cfg.setRows(cached);
      setLoading(false);
    } else {
      cfg.setRows([]);
      setLoading(true);
    }
    cfg
      .fetch((rows) => {
        if (live()) cfg.setRows(rows);
      })
      .then((res) => {
        if (!live()) return;
        cfg.setRows(res.rows);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live()) return;
        // Cold miss failed: revert to the originating step so there is a way
        // back. Background (cached-hit) failures keep the stale rows in place.
        if (!cached) {
          setError(e instanceof Error ? e.message : String(e));
          setStep(cfg.from);
        }
        setLoading(false);
      });
  };

  const pickHost = (id: string) => {
    setError("");
    setFilter("");
    setHostId(id);
    setStep("session");
    // ensureServer off the critical path — the mirror short-circuits it when
    // fresh, and the list fetch surfaces any real "server down" on its own.
    void api()?.herdrEnsureServer(id, null);
    loadStep<HerdrSessionInfo>({
      from: "host",
      peek: () => peekHerdrBrowse<HerdrSessionInfo>({ step: "sessions", hostId: id, session: null }),
      fetch: (onUpdate) => fetchHerdrSessions(id, { onUpdate }),
      setRows: setSessions,
    });
  };

  const pickSession = (name: string | null) => {
    setError("");
    setFilter("");
    setSession(name);
    setStep("workspace");
    void api()?.herdrEnsureServer(hostId, name);
    loadStep<HerdrWorkspaceInfo>({
      from: "session",
      peek: () => peekHerdrBrowse<HerdrWorkspaceInfo>({ step: "workspaces", hostId, session: name }),
      fetch: (onUpdate) => fetchHerdrWorkspaces(hostId, name, { onUpdate }),
      setRows: setWorkspaces,
    });
  };

  const pickWorkspace = (id: string) => {
    setError("");
    setFilter("");
    setWorkspaceId(id);
    setStep("tab");
    loadStep<HerdrTabInfo>({
      from: "workspace",
      peek: () => peekHerdrBrowse<HerdrTabInfo>({ step: "tabs", hostId, session, parentId: id }),
      fetch: (onUpdate) => fetchHerdrTabs(hostId, session, id, { onUpdate }),
      setRows: setTabs,
    });
  };

  const pickTab = (id: string) => {
    setError("");
    setFilter("");
    setTabId(id);
    setStep("pane");
    loadStep<HerdrPaneInfo>({
      from: "tab",
      peek: () => {
        const raw = peekHerdrBrowse<HerdrPaneInfo>({ step: "panes", hostId, session, parentId: workspaceId });
        return raw ? scopePanes(raw, id) : undefined;
      },
      fetch: (onUpdate) =>
        fetchHerdrPanes(hostId, session, workspaceId, {
          onUpdate: (raw) => onUpdate(scopePanes(raw, id)),
        }).then((res) => ({ ...res, rows: scopePanes(res.rows, id) })),
      setRows: setPanes,
    });
  };

  const placeNode = (herdr: EtherHerdr, label?: string) => {
    // Cancel / reopen must not attach after an in-flight create completes.
    if (!stillOpen()) return;
    const node = makeHerdrNode(anchor.x, anchor.y, herdr, label);
    addNode(node, { edit: false });
    setHerdrToast(`Attached herdr - ${herdr.host} - ${herdr.paneId}`);
    closeHerdrWizard();
  };

  const pickPane = async (pane: HerdrPaneInfo) => {
    if (!stillOpen()) return;
    const herdr: EtherHerdr = {
      host: hostId,
      session,
      workspaceId: pane.workspaceId ?? workspaceId,
      tabId: pane.tabId ?? tabId,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      label: pane.agent ?? pane.label,
      onDelete: "detach",
    };
    placeNode(herdr, pane.agent ? `${pane.agent} - ${pane.paneId}` : pane.paneId);
  };

  const createAtStep = async () => {
    const a = api();
    if (!stillOpen()) return;
    if (!a?.herdrCreateTab) {
      setError("herdr API unavailable");
      return;
    }
    setCreating(true);
    setError("");
    try {
      if (step === "workspace") {
        if (!createCwd.trim()) {
          setError("cwd required to create workspace");
          return;
        }
        const res = await a.herdrCreateWorkspace(hostId, session, {
          cwd: createCwd.trim(),
          label: createLabel.trim() || undefined,
        });
        if (!stillOpen()) return;
        if (!res.ok || !res.data) {
          setError(res.message ?? "create workspace failed");
          return;
        }
        if (res.data.paneId) {
          placeNode({
            host: hostId,
            session,
            workspaceId: res.data.workspaceId,
            tabId: res.data.tabId,
            paneId: res.data.paneId,
            terminalId: res.data.terminalId,
            label: createLabel.trim() || undefined,
            onDelete: "detach",
          });
          return;
        }
        // Just mutated this host — drop stale lists so the child step re-reads.
        invalidateHerdrBrowse(hostId);
        pickWorkspace(res.data.workspaceId);
        return;
      }
      if (step === "tab") {
        if (!workspaceId.trim()) {
          setError("workspace required to create tab — pick a space first");
          return;
        }
        const res = await a.herdrCreateTab(hostId, session, {
          workspaceId,
          label: createLabel.trim() || undefined,
        });
        if (!stillOpen()) return;
        if (!res.ok || !res.data) {
          setError(res.message ?? "create tab failed");
          return;
        }
        if (res.data.paneId) {
          placeNode({
            host: hostId,
            session,
            workspaceId,
            tabId: res.data.tabId,
            paneId: res.data.paneId,
            terminalId: res.data.terminalId,
            onDelete: "detach",
          });
          return;
        }
        invalidateHerdrBrowse(hostId);
        pickTab(res.data.tabId);
        return;
      }
      if (step === "pane") {
        const basePane = panes[0]?.paneId;
        if (!basePane) {
          setError("no pane to split from — wait for the list or pick a tab with panes");
          return;
        }
        const res = await a.herdrCreatePane(hostId, session, {
          paneId: basePane,
          direction: "right",
          cwd: createCwd.trim() || undefined,
        });
        if (!stillOpen()) return;
        if (!res.ok || !res.data) {
          setError(res.message ?? "create pane failed");
          return;
        }
        placeNode({
          host: hostId,
          session,
          workspaceId: res.data.workspaceId ?? workspaceId,
          tabId: res.data.tabId ?? tabId,
          paneId: res.data.paneId,
          terminalId: res.data.terminalId,
          onDelete: "detach",
        });
      }
    } catch (e) {
      if (stillOpen()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Always clear — placeNode closes the wizard (stillOpen=false) and the
      // component stays mounted; a gated clear leaves create permanently disabled.
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]" onClick={() => closeHerdrWizard()}>
      <div
        className="w-full max-w-md rounded-lg border border-white/10 bg-raise-2 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Attach herdr pane"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em]" style={{ color: HUE.steel }}>
              herdr - attach
            </div>
            <div className="text-sm font-semibold text-ink">
              {step === "host" && "Host"}
              {step === "session" && "Session"}
              {step === "workspace" && "Space (workspace)"}
              {step === "tab" && "Tab"}
              {step === "pane" && "Pane"}
            </div>
            {seedApplied && seed?.host ? (
              <div className="mt-0.5 text-[10px] text-faint">
                region - {[seed.host, seed.session === null ? "default" : seed.session, seed.workspaceId, seed.tabId]
                  .filter((part) => part != null && part !== "")
                  .join(" - ")}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {seedApplied ? (
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-dim hover:bg-white/10 hover:text-ink"
                onClick={ignoreRegionDefaults}
                title="Ignore region defaults and pick host/session freely"
              >
                override
              </button>
            ) : null}
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-dim hover:bg-white/10 hover:text-ink"
              onClick={() => closeHerdrWizard()}
            >
              cancel
            </button>
          </div>
        </div>
        <div className="space-y-2 px-4 py-3">
          <input
            autoFocus
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-ink outline-none focus:border-amber-500/40"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {error ? <div className="text-xs text-crimson">{error}</div> : null}
          <div className="max-h-64 overflow-auto rounded border border-white/5">
            {rows.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-faint">
                {loading ? (
                  <>
                    <ActivityMark mode="wave" tone="amber" size="inline" label="loading" />
                    <span>loading…</span>
                  </>
                ) : (
                  <span>No matches.</span>
                )}
              </div>
            ) : (
              rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className="flex w-full flex-col items-start gap-0.5 border-b border-white/5 px-3 py-2 text-left hover:bg-white/5"
                  onPointerDown={() => applyPick(decidePickFromPointer, row.key, row.onPick)}
                  onClick={() => applyPick(decidePickFromClick, row.key, row.onPick)}
                >
                  <span className="text-sm text-ink">{row.label}</span>
                  <span className="text-[11px] text-faint">{row.sub}</span>
                </button>
              ))
            )}
          </div>
          {(step === "workspace" || step === "tab" || step === "pane") && (
            <div className="rounded border border-dashed border-white/10 p-2 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-faint">+ create</div>
              {step === "workspace" || step === "pane" ? (
                <input
                  className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-ink"
                  placeholder="cwd"
                  value={createCwd}
                  onChange={(e) => setCreateCwd(e.target.value)}
                />
              ) : null}
              {step !== "pane" ? (
                <input
                  className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-ink"
                  placeholder="label"
                  value={createLabel}
                  onChange={(e) => setCreateLabel(e.target.value)}
                />
              ) : null}
              <button
                type="button"
                className="rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
                onClick={() => void createAtStep()}
                disabled={creating}
              >
                create {step}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
