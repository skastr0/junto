import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type {
  QuasarSearchMatch,
  QuasarSessionRow,
  QuasarSessionsResult,
  TowerBrowseResult,
  TowerGlyphRow,
  TowerSearchMatch,
  TowerSearchResult,
  TowerSignalRow,
  QuasarSearchResult,
} from "@shared/ipc";
import {
  fetchQuasarSearch,
  fetchQuasarSessions,
  fetchTowerBrowse,
  fetchTowerSearch,
  formatCollapsedSummary,
  glyphStateHue,
  groupGlyphs,
  sessionStats,
  sessionTitle,
  shortDate,
  shortKind,
  signalStatusHue,
} from "../lib/browse";
import { DIM, HUE, INK, SOURCE_HUE, withAlpha } from "../lib/theme";

// Read-only detail views for a bound project — glyphs, signals, and sessions
// never become canvas nodes. Lazily loaded on first selection of the node.

type BrowseTab = "glyphs" | "signals" | "sessions";
const TAB_ORDER: ReadonlyArray<BrowseTab> = ["glyphs", "signals", "sessions"];

function LoadingLine({ label }: { readonly label: string }) {
  return <div className="vellum-dot--pulse py-2 text-[10px]" style={{ color: DIM }}>{label}</div>;
}

function EmptyLine({ label }: { readonly label: string }) {
  return <div className="py-2 text-[10px]" style={{ color: DIM }}>{label}</div>;
}

function Dot({ hue, dim }: { readonly hue: string; readonly dim?: boolean }) {
  return <i className="inline-block size-[5px] shrink-0 rounded-full" style={{ background: hue, opacity: dim ? 0.5 : 1 }} />;
}

function GlyphRow({ glyph }: { readonly glyph: TowerGlyphRow }) {
  return <div className="flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }}>
    <Dot hue={glyphStateHue(glyph.state)} />
    <span className="shrink-0 uppercase tracking-[.06em]" style={{ color: glyphStateHue(glyph.state) }}>{glyph.state}</span>
    <span className="shrink-0" title={glyph.glyphId}>{glyph.glyphId}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={glyph.title}>{glyph.title}</span>
    <span className="shrink-0 uppercase tracking-[.08em]">{glyph.orbit}</span>
  </div>;
}

function GlyphsTab({ result, loading }: { readonly result: TowerBrowseResult | undefined; readonly loading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (loading) return <LoadingLine label="loading glyphs…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "tower unreachable"} />;
  const { visible, collapsedRows, collapsedCounts } = groupGlyphs(result.glyphs);
  if (visible.length === 0 && collapsedRows.length === 0) return <EmptyLine label="no glyphs" />;
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
    {visible.map((glyph) => <GlyphRow key={glyph.glyphId} glyph={glyph} />)}
    {collapsedCounts.length > 0 ? (
      <button type="button" className="w-full py-1 text-left text-[9px] uppercase tracking-[.1em] transition hover:opacity-80" style={{ color: DIM }} onClick={() => setExpanded((value) => !value)}>
        {formatCollapsedSummary(collapsedCounts)}
      </button>
    ) : null}
    {expanded ? collapsedRows.map((glyph) => <GlyphRow key={glyph.glyphId} glyph={glyph} />) : null}
  </div>;
}

function SignalRow({ signal }: { readonly signal: TowerSignalRow }) {
  return <div className="flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }}>
    <Dot hue={signalStatusHue(signal.status)} dim={signal.status === "dead"} />
    <span className="shrink-0 uppercase tracking-[.08em]" title={signal.kind}>{shortKind(signal.kind)}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={signal.summary}>{signal.summary}</span>
  </div>;
}

function SignalsTab({ result, loading }: { readonly result: TowerBrowseResult | undefined; readonly loading: boolean }) {
  if (loading) return <LoadingLine label="loading signals…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "tower unreachable"} />;
  if (result.signals.length === 0) return <EmptyLine label="no signals" />;
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">{result.signals.map((signal) => <SignalRow key={signal.signalId} signal={signal} />)}</div>;
}

function SessionRow({ session }: { readonly session: QuasarSessionRow }) {
  const date = shortDate(session.updatedAt);
  return <div className="flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }}>
    <span className="shrink-0 uppercase tracking-[.08em]" style={{ color: SOURCE_HUE.quasar }}>{session.provider}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={sessionTitle(session)}>{sessionTitle(session)}</span>
    <span className="shrink-0 tabular-nums">{sessionStats(session)}</span>
    {date ? <span className="shrink-0">{date}</span> : null}
  </div>;
}

function SessionsTab({ result, loading }: { readonly result: QuasarSessionsResult | undefined; readonly loading: boolean }) {
  if (loading) return <LoadingLine label="loading sessions…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "quasar unreachable"} />;
  if (result.sessions.length === 0) return <EmptyLine label="no sessions" />;
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">{result.sessions.map((session) => <SessionRow key={session.sessionId} session={session} />)}</div>;
}

function TowerMatchRow({ match }: { readonly match: TowerSearchMatch }) {
  return <div className="py-1.5 text-[10px]">
    <div className="flex items-center gap-2">
      <span className="shrink-0 uppercase tracking-[.08em]" style={{ color: SOURCE_HUE.tower }}>{match.family}</span>
      <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={match.title}>{match.title}</span>
    </div>
    {match.summary ? <div className="mt-0.5 truncate" style={{ color: DIM }} title={match.summary}>{match.summary}</div> : null}
  </div>;
}

function QuasarMatchRow({ match }: { readonly match: QuasarSearchMatch }) {
  return <div className="py-1.5 text-[10px]">
    <span className="uppercase tracking-[.08em]" style={{ color: SOURCE_HUE.quasar }}>{match.provider}</span>
    <div className="mt-0.5 truncate" style={{ color: DIM }} title={match.text}>{match.text}</div>
  </div>;
}

function SearchResults({
  towerResult,
  quasarResult,
  loading,
}: {
  readonly towerResult: TowerSearchResult | undefined;
  readonly quasarResult: QuasarSearchResult | undefined;
  readonly loading: boolean;
}) {
  if (loading) return <LoadingLine label="searching…" />;
  const towerMatches = towerResult?.ok ? towerResult.matches : [];
  const quasarMatches = quasarResult?.ok ? quasarResult.matches : [];
  if (!towerResult && !quasarResult) return null;
  if (towerMatches.length === 0 && quasarMatches.length === 0 && (!towerResult || towerResult.ok) && (!quasarResult || quasarResult.ok)) {
    return <EmptyLine label="no matches" />;
  }
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
    {towerResult ? <div className="mb-2">
      <div className="text-[8px] uppercase tracking-[.14em]" style={{ color: SOURCE_HUE.tower }}>tower · {towerResult.ok ? towerMatches.length : "unreachable"}</div>
      {towerResult.ok ? towerMatches.map((match, index) => <TowerMatchRow key={`${match.family}-${index}`} match={match} />) : null}
    </div> : null}
    {quasarResult ? <div>
      <div className="text-[8px] uppercase tracking-[.14em]" style={{ color: SOURCE_HUE.quasar }}>quasar · {quasarResult.ok ? quasarMatches.length : "unreachable"}</div>
      {quasarResult.ok ? quasarMatches.map((match, index) => <QuasarMatchRow key={`${match.sessionId}-${index}`} match={match} />) : null}
    </div> : null}
  </div>;
}

export function ProjectBrowseSection({ node }: { readonly node: CanvasNode }) {
  const bindings = node.ether?.bindings ?? [];
  const towerKey = bindings.find((binding) => binding.source === "tower")?.ref.key;
  const quasarKey = bindings.find((binding) => binding.source === "quasar")?.ref.key;
  const availableTabs = TAB_ORDER.filter((candidate) =>
    candidate === "sessions" ? Boolean(quasarKey) : Boolean(towerKey));

  const [tab, setTab] = useState<BrowseTab>(availableTabs[0] ?? "glyphs");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [towerBrowse, setTowerBrowse] = useState<TowerBrowseResult>();
  const [towerLoading, setTowerLoading] = useState(Boolean(towerKey));
  const [quasarSessions, setQuasarSessions] = useState<QuasarSessionsResult>();
  const [quasarLoading, setQuasarLoading] = useState(Boolean(quasarKey));
  const [towerSearchResult, setTowerSearchResult] = useState<TowerSearchResult>();
  const [quasarSearchResult, setQuasarSearchResult] = useState<QuasarSearchResult>();
  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // fetchTowerBrowse/fetchQuasarSessions never reject (every failure path
    // resolves to an { ok: false } result) — the .catch is a belt-and-braces
    // floor so a future change to that invariant still clears the loading
    // line instead of leaving it pulsing forever.
    if (towerKey) {
      setTowerLoading(true);
      void fetchTowerBrowse(towerKey)
        .then((result) => { if (!cancelled) setTowerBrowse(result); })
        .catch(() => { if (!cancelled) setTowerBrowse({ ok: false, error: "tower unreachable", glyphs: [], signals: [] }); })
        .finally(() => { if (!cancelled) setTowerLoading(false); });
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
      <div className="mt-2 flex gap-1">
        {availableTabs.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="rounded px-2 py-1 text-[8px] uppercase tracking-[.12em] transition"
            style={{
              color: activeTab === candidate ? HUE.amber : DIM,
              background: activeTab === candidate ? withAlpha(HUE.amber, 0.1) : "transparent",
              border: `1px solid ${activeTab === candidate ? withAlpha(HUE.amber, 0.4) : "transparent"}`,
            }}
            onClick={() => setTab(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>
      <div className="mt-2">
        {activeTab === "glyphs" ? <GlyphsTab result={towerBrowse} loading={towerLoading} /> : null}
        {activeTab === "signals" ? <SignalsTab result={towerBrowse} loading={towerLoading} /> : null}
        {activeTab === "sessions" ? <SessionsTab result={quasarSessions} loading={quasarLoading} /> : null}
      </div>
    </>}
  </div>;
}
