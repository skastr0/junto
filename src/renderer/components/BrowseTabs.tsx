import { useState } from "react";
import type {
  QuasarSearchMatch,
  QuasarSessionRow,
  QuasarSessionsResult,
  TowerBrowseResult,
  TowerDispatchRow,
  TowerDispatchesResult,
  TowerGlyphRow,
  TowerSearchMatch,
  TowerSearchResult,
  TowerSignalRow,
  QuasarSearchResult,
} from "@shared/ipc";
import {
  formatCollapsedSummary,
  glyphStateHue,
  groupGlyphs,
  sessionStats,
  sessionTitle,
  shortDate,
  shortKind,
  signalStatusHue,
} from "../lib/browse";
import { DIM, INK, SOURCE_HUE } from "../lib/theme";
import { EmptyLine, LoadingLine } from "./BrowseStatusLine";
import type { BrowseDetailTarget } from "./BrowseDetailModal";

// The four browse tab bodies (GLYPHS/SIGNALS/SESSIONS/DISPATCHES) plus the
// free-text search results view. Every row opens BrowseDetailModal via the
// onOpen callback threaded down from ProjectBrowseSection.

function Dot({ hue, dim }: { readonly hue: string; readonly dim?: boolean }) {
  return <i className="inline-block size-[5px] shrink-0 rounded-full" style={{ background: hue, opacity: dim ? 0.5 : 1 }} />;
}

function GlyphRow({ glyph, onOpen }: { readonly glyph: TowerGlyphRow; readonly onOpen: () => void }) {
  return <button type="button" className="vellum-row-button flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }} onClick={onOpen} aria-label={`Open glyph ${glyph.title}`}>
    <Dot hue={glyphStateHue(glyph.state)} />
    <span className="shrink-0 uppercase tracking-[.06em]" style={{ color: glyphStateHue(glyph.state) }}>{glyph.state}</span>
    <span className="shrink-0" title={glyph.glyphId}>{glyph.glyphId}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={glyph.title}>{glyph.title}</span>
    <span className="shrink-0 uppercase tracking-[.08em]">{glyph.orbit}</span>
  </button>;
}

export function GlyphsTab({
  result,
  loading,
  projectKey,
  onOpen,
}: {
  readonly result: TowerBrowseResult | undefined;
  readonly loading: boolean;
  readonly projectKey: string;
  readonly onOpen: (target: BrowseDetailTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (loading) return <LoadingLine label="loading glyphs…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "tower unreachable"} />;
  const { visible, collapsedRows, collapsedCounts } = groupGlyphs(result.glyphs);
  if (visible.length === 0 && collapsedRows.length === 0) return <EmptyLine label="no glyphs" />;
  const open = (glyph: TowerGlyphRow) => onOpen({ kind: "glyph", projectKey, orbit: glyph.orbit, glyphId: glyph.glyphId });
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
    {visible.map((glyph) => <GlyphRow key={glyph.glyphId} glyph={glyph} onOpen={() => open(glyph)} />)}
    {collapsedCounts.length > 0 ? (
      <button type="button" className="w-full truncate py-1 text-left text-[10px] uppercase tracking-[.1em] transition hover:opacity-80" style={{ color: DIM }} onClick={() => setExpanded((value) => !value)}>
        {formatCollapsedSummary(collapsedCounts)}
      </button>
    ) : null}
    {expanded ? collapsedRows.map((glyph) => <GlyphRow key={glyph.glyphId} glyph={glyph} onOpen={() => open(glyph)} />) : null}
  </div>;
}

function SignalRow({ signal, onOpen }: { readonly signal: TowerSignalRow; readonly onOpen: () => void }) {
  return <button type="button" className="vellum-row-button flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }} onClick={onOpen} aria-label={`Open signal ${signal.summary}`}>
    <Dot hue={signalStatusHue(signal.status)} dim={signal.status === "dead"} />
    <span className="shrink-0 uppercase tracking-[.08em]" title={signal.kind}>{shortKind(signal.kind)}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={signal.summary}>{signal.summary}</span>
  </button>;
}

export function SignalsTab({
  result,
  loading,
  projectKey,
  onOpen,
}: {
  readonly result: TowerBrowseResult | undefined;
  readonly loading: boolean;
  readonly projectKey: string;
  readonly onOpen: (target: BrowseDetailTarget) => void;
}) {
  if (loading) return <LoadingLine label="loading signals…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "tower unreachable"} />;
  if (result.signals.length === 0) return <EmptyLine label="no signals" />;
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
    {result.signals.map((signal) => (
      <SignalRow
        key={signal.signalId}
        signal={signal}
        onOpen={() => onOpen({ kind: "signal", projectKey, orbit: signal.orbit, signalId: signal.signalId })}
      />
    ))}
  </div>;
}

function SessionRow({ session, onOpen }: { readonly session: QuasarSessionRow; readonly onOpen: () => void }) {
  // updatedAt is frequently absent (claude/codex/antigravity) — the backend
  // preserves true server order, so a missing date renders nothing rather
  // than a fabricated placeholder that would fake an ordering cue.
  const date = shortDate(session.updatedAt);
  return <button type="button" className="vellum-row-button flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }} onClick={onOpen} aria-label={`Open session ${sessionTitle(session)}`}>
    <span className="shrink-0 uppercase tracking-[.08em]" style={{ color: SOURCE_HUE.quasar }}>{session.provider}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={sessionTitle(session)}>{sessionTitle(session)}</span>
    <span className="shrink-0 tabular-nums">{sessionStats(session)}</span>
    {date ? <span className="shrink-0">{date}</span> : null}
  </button>;
}

export function SessionsTab({
  result,
  loading,
  onOpen,
}: {
  readonly result: QuasarSessionsResult | undefined;
  readonly loading: boolean;
  readonly onOpen: (target: BrowseDetailTarget) => void;
}) {
  if (loading) return <LoadingLine label="loading sessions…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "quasar unreachable"} />;
  if (result.sessions.length === 0) return <EmptyLine label="no sessions" />;
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
    {result.sessions.map((session) => (
      <SessionRow key={session.sessionId} session={session} onOpen={() => onOpen({ kind: "session", sessionId: session.sessionId })} />
    ))}
  </div>;
}

function DispatchRow({ dispatch, onOpen }: { readonly dispatch: TowerDispatchRow; readonly onOpen: () => void }) {
  return <button type="button" className="vellum-row-button flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }} onClick={onOpen} aria-label={`Open dispatch ${dispatch.title}`}>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={dispatch.title}>{dispatch.title}</span>
    {dispatch.status ? <span className="shrink-0 uppercase tracking-[.08em]">{dispatch.status}</span> : null}
    {dispatch.orbit ? <span className="shrink-0 uppercase tracking-[.08em]">{dispatch.orbit}</span> : null}
  </button>;
}

export function DispatchesTab({
  result,
  loading,
  onOpen,
}: {
  readonly result: TowerDispatchesResult | undefined;
  readonly loading: boolean;
  readonly onOpen: (target: BrowseDetailTarget) => void;
}) {
  if (loading) return <LoadingLine label="loading dispatches…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "dispatches unreachable"} />;
  if (result.dispatches.length === 0) return <EmptyLine label="no dispatches" />;
  return <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
    {result.dispatches.map((dispatch) => (
      <DispatchRow key={dispatch.id} dispatch={dispatch} onOpen={() => onOpen({ kind: "dispatch", dispatch })} />
    ))}
  </div>;
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

export function SearchResults({
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
