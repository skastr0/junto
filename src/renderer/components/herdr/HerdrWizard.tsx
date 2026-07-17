import { useEffect, useMemo, useState } from "react";
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
import { closeHerdrWizard, herdr$, setHerdrToast } from "../../lib/herdr-state";
import { bootstrapHerdrWizard, type HerdrWizardApi, type HerdrWizardStep } from "../../lib/herdr-wizard-seed";
import { getVellumApi } from "../../lib/vellum-api";
import { HUE } from "../../lib/theme";

type Step = HerdrWizardStep;

const api = () =>
  getVellumApi() as
    | (ReturnType<typeof getVellumApi> & {
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
  const [step, setStep] = useState<Step>("host");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep("host");
    setError("");
    setFilter("");
    setHostId("");
    setSession(null);
    setWorkspaceId("");
    setTabId("");
    setCreateCwd("");
    setCreateLabel("");
    setSeedApplied(false);
    setBusy(true);

    const applySnapshot = (snap: Awaited<ReturnType<typeof bootstrapHerdrWizard>>) => {
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
        if (!cancelled) {
          setError("herdr API unavailable");
          setBusy(false);
        }
        return;
      }
      try {
        const snap = await bootstrapHerdrWizard(
          a as HerdrWizardApi,
          herdr$.wizardSeed.peek(),
        );
        if (!cancelled) applySnapshot(snap);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** Escape hatch: drop region seed and restart full wizard at host. */
  const ignoreRegionDefaults = () => {
    herdr$.wizardSeed.set(null);
    setSeedApplied(false);
    setStep("host");
    setError("");
    setFilter("");
    setHostId("");
    setSession(null);
    setWorkspaceId("");
    setTabId("");
    setWorkspaces([]);
    setTabs([]);
    setPanes([]);
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
          sub: `${w.workspaceId}${w.paneCount != null ? ` · ${w.paneCount} panes` : ""}`,
          onPick: () => void pickWorkspace(w.workspaceId),
        }));
    }
    if (step === "tab") {
      return tabs
        .filter((t) => !needle || t.label?.toLowerCase().includes(needle) || t.tabId.includes(needle))
        .map((t) => ({
          key: t.tabId,
          label: t.label || t.tabId,
          sub: `${t.tabId}${t.agentStatus ? ` · ${t.agentStatus}` : ""}`,
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
        label: p.agent ? `${p.agent} · ${p.paneId}` : p.paneId,
        sub: [p.cwd, p.agentStatus].filter(Boolean).join(" · "),
        onPick: () => void pickPane(p),
      }));
  }, [step, hosts, sessions, workspaces, tabs, panes, needle]);

  if (!open) return null;

  const pickHost = async (id: string) => {
    setBusy(true);
    setError("");
    setHostId(id);
    const a = api();
    if (!a) return setBusy(false);
    const ensured = await a.herdrEnsureServer(id, null);
    if (!ensured.ok) {
      setError(ensured.message ?? "ensure server failed");
      setBusy(false);
      return;
    }
    const sess = await a.herdrListSessions(id);
    setSessions(sess.ok ? sess.data ?? [] : []);
    setStep("session");
    setFilter("");
    setBusy(false);
  };

  const pickSession = async (name: string | null) => {
    setBusy(true);
    setError("");
    setSession(name);
    const a = api();
    if (!a) return setBusy(false);
    const ensured = await a.herdrEnsureServer(hostId, name);
    if (!ensured.ok) {
      setError(ensured.message ?? "ensure server failed");
      setBusy(false);
      return;
    }
    const list = await a.herdrListWorkspaces(hostId, name);
    if (!list.ok) {
      setError(list.message ?? "list workspaces failed");
      setBusy(false);
      return;
    }
    setWorkspaces(list.data ?? []);
    setStep("workspace");
    setFilter("");
    setBusy(false);
  };

  const pickWorkspace = async (id: string) => {
    setBusy(true);
    setError("");
    setWorkspaceId(id);
    const a = api();
    if (!a) return setBusy(false);
    const list = await a.herdrListTabs(hostId, session, id);
    if (!list.ok) {
      setError(list.message ?? "list tabs failed");
      setBusy(false);
      return;
    }
    setTabs(list.data ?? []);
    setStep("tab");
    setFilter("");
    setBusy(false);
  };

  const pickTab = async (id: string) => {
    setBusy(true);
    setError("");
    setTabId(id);
    const a = api();
    if (!a) return setBusy(false);
    const list = await a.herdrListPanes(hostId, session, workspaceId);
    if (!list.ok) {
      setError(list.message ?? "list panes failed");
      setBusy(false);
      return;
    }
    const scoped = (list.data ?? []).filter((p) => !p.tabId || p.tabId === id);
    setPanes(scoped.length > 0 ? scoped : list.data ?? []);
    setStep("pane");
    setFilter("");
    setBusy(false);
  };

  const placeNode = (herdr: EtherHerdr, label?: string) => {
    const node = makeHerdrNode(anchor.x, anchor.y, herdr, label);
    addNode(node, { edit: false });
    setHerdrToast(`Attached herdr · ${herdr.host} · ${herdr.paneId}`);
    closeHerdrWizard();
  };

  const pickPane = async (pane: HerdrPaneInfo) => {
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
    placeNode(herdr, pane.agent ? `${pane.agent} · ${pane.paneId}` : pane.paneId);
  };

  const createAtStep = async () => {
    const a = api();
    if (!a) return;
    setBusy(true);
    setError("");
    try {
      if (step === "workspace") {
        if (!createCwd.trim()) {
          setError("cwd required to create workspace");
          setBusy(false);
          return;
        }
        const res = await a.herdrCreateWorkspace(hostId, session, {
          cwd: createCwd.trim(),
          label: createLabel.trim() || undefined,
        });
        if (!res.ok || !res.data) {
          setError(res.message ?? "create workspace failed");
          setBusy(false);
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
          setBusy(false);
          return;
        }
        await pickWorkspace(res.data.workspaceId);
        return;
      }
      if (step === "tab") {
        const res = await a.herdrCreateTab(hostId, session, {
          workspaceId,
          label: createLabel.trim() || undefined,
        });
        if (!res.ok || !res.data) {
          setError(res.message ?? "create tab failed");
          setBusy(false);
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
          setBusy(false);
          return;
        }
        await pickTab(res.data.tabId);
        return;
      }
      if (step === "pane") {
        const basePane = panes[0]?.paneId;
        const res = await a.herdrCreatePane(hostId, session, {
          paneId: basePane,
          direction: "right",
          cwd: createCwd.trim() || undefined,
        });
        if (!res.ok || !res.data) {
          setError(res.message ?? "create pane failed");
          setBusy(false);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4" onClick={() => closeHerdrWizard()}>
      <div
        className="w-full max-w-md rounded-lg border border-white/10 bg-[#141210] shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Attach herdr pane"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em]" style={{ color: HUE.steel }}>
              herdr · attach
            </div>
            <div className="text-sm font-semibold text-[#EDE6DA]">
              {step === "host" && "Host"}
              {step === "session" && "Session"}
              {step === "workspace" && "Space (workspace)"}
              {step === "tab" && "Tab"}
              {step === "pane" && "Pane"}
            </div>
            {seedApplied && seed?.host ? (
              <div className="mt-0.5 text-[10px] text-slate-500">
                region · {[seed.host, seed.session === null ? "default" : seed.session, seed.workspaceId, seed.tabId]
                  .filter((part) => part != null && part !== "")
                  .join(" · ")}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {seedApplied ? (
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-[#EDE6DA]"
                onClick={ignoreRegionDefaults}
                title="Ignore region defaults and pick host/session freely"
              >
                override
              </button>
            ) : null}
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-[#EDE6DA]"
              onClick={() => closeHerdrWizard()}
            >
              cancel
            </button>
          </div>
        </div>
        <div className="space-y-2 px-4 py-3">
          <input
            autoFocus
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#EDE6DA] outline-none focus:border-amber-500/40"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={busy}
          />
          {error ? <div className="text-xs text-[#E5484D]">{error}</div> : null}
          <div className="max-h-64 overflow-auto rounded border border-white/5">
            {rows.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-500">{busy ? "loading…" : "No matches."}</div>
            ) : (
              rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className="flex w-full flex-col items-start gap-0.5 border-b border-white/5 px-3 py-2 text-left hover:bg-white/5"
                  onClick={row.onPick}
                  disabled={busy}
                >
                  <span className="text-sm text-[#EDE6DA]">{row.label}</span>
                  <span className="text-[11px] text-slate-500">{row.sub}</span>
                </button>
              ))
            )}
          </div>
          {(step === "workspace" || step === "tab" || step === "pane") && (
            <div className="rounded border border-dashed border-white/10 p-2 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">+ create</div>
              {step === "workspace" || step === "pane" ? (
                <input
                  className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-[#EDE6DA]"
                  placeholder="cwd"
                  value={createCwd}
                  onChange={(e) => setCreateCwd(e.target.value)}
                />
              ) : null}
              {step !== "pane" ? (
                <input
                  className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-[#EDE6DA]"
                  placeholder="label"
                  value={createLabel}
                  onChange={(e) => setCreateLabel(e.target.value)}
                />
              ) : null}
              <button
                type="button"
                className="rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/30"
                onClick={() => void createAtStep()}
                disabled={busy}
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
