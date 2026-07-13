import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type {
  QuasarSessionsResult,
  TowerBrowseResult,
  TowerDispatchesResult,
  TowerSearchResult,
  QuasarSearchResult,
} from "@shared/ipc";
import {
  fetchQuasarSearch,
  fetchQuasarSessions,
  fetchTowerBrowse,
  fetchTowerDispatches,
  fetchTowerSearch,
} from "../lib/browse";
import { DIM, INK } from "../lib/theme";
import { BrowseDetailModal, type BrowseDetailTarget } from "./BrowseDetailModal";
import { DispatchesTab, GlyphsTab, SearchResults, SessionsTab, SignalsTab } from "./BrowseTabs";

// Read-only detail views for a bound project — glyphs, signals, and sessions
// never become canvas nodes. Lazily loaded on first selection of the node.
// Every row also opens a read-only detail modal (BrowseDetailModal) on click.
// Tab bodies live in BrowseTabs.tsx; this file owns fetching, the tab
// picker, and free-text search.

type BrowseTab = "glyphs" | "signals" | "sessions" | "dispatches";
const TAB_ORDER: ReadonlyArray<BrowseTab> = ["glyphs", "signals", "sessions", "dispatches"];

export function ProjectBrowseSection({ node }: { readonly node: CanvasNode }) {
  const bindings = node.ether?.bindings ?? [];
  const towerKey = bindings.find((binding) => binding.source === "tower")?.ref.key;
  const quasarKey = bindings.find((binding) => binding.source === "quasar")?.ref.key;

  const [tab, setTab] = useState<BrowseTab>("glyphs");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [towerBrowse, setTowerBrowse] = useState<TowerBrowseResult>();
  const [towerLoading, setTowerLoading] = useState(Boolean(towerKey));
  const [quasarSessions, setQuasarSessions] = useState<QuasarSessionsResult>();
  const [quasarLoading, setQuasarLoading] = useState(Boolean(quasarKey));
  const [dispatches, setDispatches] = useState<TowerDispatchesResult>();
  const [dispatchesLoading, setDispatchesLoading] = useState(Boolean(towerKey));
  const [towerSearchResult, setTowerSearchResult] = useState<TowerSearchResult>();
  const [quasarSearchResult, setQuasarSearchResult] = useState<QuasarSearchResult>();
  const [searchLoading, setSearchLoading] = useState(false);
  const [detail, setDetail] = useState<BrowseDetailTarget>();

  // DISPATCHES only joins the picker once the probe comes back ok — a
  // gateway that doesn't expose the route degrades to "not offered" rather
  // than a fourth tab that always errors.
  const availableTabs = TAB_ORDER.filter((candidate) => {
    if (candidate === "sessions") return Boolean(quasarKey);
    if (candidate === "dispatches") return Boolean(towerKey) && dispatches?.ok === true;
    return Boolean(towerKey);
  });

  useEffect(() => {
    let cancelled = false;
    // fetchTowerBrowse/fetchQuasarSessions/fetchTowerDispatches never reject
    // (every failure path resolves to an { ok: false } result) — the .catch
    // is a belt-and-braces floor so a future change to that invariant still
    // clears the loading line instead of leaving it pulsing forever.
    if (towerKey) {
      setTowerLoading(true);
      void fetchTowerBrowse(towerKey)
        .then((result) => { if (!cancelled) setTowerBrowse(result); })
        .catch(() => { if (!cancelled) setTowerBrowse({ ok: false, error: "tower unreachable", glyphs: [], signals: [] }); })
        .finally(() => { if (!cancelled) setTowerLoading(false); });
      // Probed once per project (cached in lib/browse) — the same result
      // both gates the tab's presence and supplies its rows.
      setDispatchesLoading(true);
      void fetchTowerDispatches(towerKey)
        .then((result) => { if (!cancelled) setDispatches(result); })
        .catch(() => { if (!cancelled) setDispatches({ ok: false, error: "tower unreachable", dispatches: [] }); })
        .finally(() => { if (!cancelled) setDispatchesLoading(false); });
    }
    if (quasarKey) {
      setQuasarLoading(true);
      void fetchQuasarSessions(quasarKey, 30)
        .then((result) => { if (!cancelled) setQuasarSessions(result); })
        .catch(() => { if (!cancelled) setQuasarSessions({ ok: false, error: "quasar unreachable", sessions: [] }); })
        .finally(() => { if (!cancelled) setQuasarLoading(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [towerKey, quasarKey]);

  useEffect(() => {
    if (query.trim() === "") { setDebouncedQuery(""); return; }
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) {
      setTowerSearchResult(undefined);
      setQuasarSearchResult(undefined);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    const towerPromise = towerKey ? fetchTowerSearch(debouncedQuery, towerKey) : undefined;
    const quasarPromise = quasarKey ? fetchQuasarSearch(debouncedQuery, quasarKey) : undefined;
    // Same never-reject invariant as the load effect above — .catch is a
    // floor, not a path either fetcher is expected to take.
    void Promise.all([towerPromise, quasarPromise])
      .then(([towerRes, quasarRes]) => {
        if (cancelled) return;
        setTowerSearchResult(towerRes);
        setQuasarSearchResult(quasarRes);
      })
      .catch(() => {
        if (cancelled) return;
        setTowerSearchResult(undefined);
        setQuasarSearchResult(undefined);
      })
      .finally(() => { if (!cancelled) setSearchLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedQuery, towerKey, quasarKey]);

  if (availableTabs.length === 0) return null;
  const searching = debouncedQuery.length > 0;
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0]!;

  return <div className="inspector-section">
    <div className="inspector-section__label"><Search size={11} /> browse</div>
    <div className="mt-2 flex h-7 items-center gap-1.5 rounded-md border px-2" style={{ borderColor: "rgba(237,230,218,.14)", background: "rgba(255,255,255,.02)" }}>
      <Search size={11} style={{ color: DIM }} />
      <input
        aria-label="Search glyphs, signals, sessions"
        className="h-full min-w-0 flex-1 bg-transparent text-[10px] outline-none"
        style={{ color: INK }}
        placeholder="search glyphs, signals, sessions…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>
    {searching ? (
      <div className="mt-2">
        <SearchResults towerResult={towerSearchResult} quasarResult={quasarSearchResult} loading={searchLoading} />
      </div>
    ) : <>
      <select
        aria-label="Browse tab"
        className="vellum-picker-select mt-2"
        value={activeTab}
        onChange={(event) => setTab(event.target.value as BrowseTab)}
      >
        {availableTabs.map((candidate) => <option key={candidate} value={candidate}>{candidate.toUpperCase()}</option>)}
      </select>
      <div className="mt-2">
        {activeTab === "glyphs" ? <GlyphsTab result={towerBrowse} loading={towerLoading} projectKey={towerKey ?? ""} onOpen={setDetail} /> : null}
        {activeTab === "signals" ? <SignalsTab result={towerBrowse} loading={towerLoading} projectKey={towerKey ?? ""} onOpen={setDetail} /> : null}
        {activeTab === "sessions" ? <SessionsTab result={quasarSessions} loading={quasarLoading} onOpen={setDetail} /> : null}
        {activeTab === "dispatches" ? <DispatchesTab result={dispatches} loading={dispatchesLoading} onOpen={setDetail} /> : null}
      </div>
    </>}
    {detail ? <BrowseDetailModal target={detail} onClose={() => setDetail(undefined)} /> : null}
  </div>;
}
