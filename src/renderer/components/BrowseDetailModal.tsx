import { useEffect, useState } from "react";
import type {
  QuasarSessionDetail,
  QuasarSessionDetailResult,
  TowerDispatchRow,
  TowerGlyphDetail,
  TowerGlyphReadResult,
  TowerSignalDetail,
  TowerSignalReadResult,
} from "@shared/ipc";
import {
  fetchQuasarSessionDetail,
  fetchTowerGlyphRead,
  fetchTowerSignalRead,
  sessionDetailStats,
  sessionTitle,
} from "../lib/browse";
import { EmptyLine, LoadingLine } from "./BrowseStatusLine";
import { DetailModal } from "./DetailModal";

// The row-detail modal's whole input: which kind, plus exactly the ids that
// kind's fetcher needs. The dispatch variant carries its row directly — the
// row IS the detail, there is no separate read endpoint for it.
export type BrowseDetailTarget =
  | { readonly kind: "glyph"; readonly projectKey: string; readonly orbit: string; readonly glyphId: string }
  | { readonly kind: "signal"; readonly projectKey: string; readonly orbit: string; readonly signalId: string }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "dispatch"; readonly dispatch: TowerDispatchRow };

function ChipRow({ label, values }: { readonly label: string; readonly values: ReadonlyArray<string> }) {
  if (values.length === 0) return null;
  return <div className="mt-3">
    <div className="vellum-modal__section-label">{label}</div>
    <div className="vellum-modal__chips">{values.map((value) => <span key={value} className="vellum-modal__chip">{value}</span>)}</div>
  </div>;
}

function GlyphDetailBody({ target }: { readonly target: Extract<BrowseDetailTarget, { kind: "glyph" }> }) {
  const [result, setResult] = useState<TowerGlyphReadResult>();
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    // fetchTowerGlyphRead never rejects (browse.ts resolves every failure to
    // an { ok: false } result) — .catch is a belt-and-braces floor so a
    // future change to that invariant still resolves the loading line.
    void fetchTowerGlyphRead(target.projectKey, target.orbit, target.glyphId)
      .then((value) => { if (!cancelled) setResult(value); })
      .catch(() => { if (!cancelled) setResult({ ok: false, error: "tower unreachable" }); });
    return () => { cancelled = true; };
  }, [target.projectKey, target.orbit, target.glyphId]);

  if (!result) return <LoadingLine label="loading glyph…" />;
  if (!result.ok || !result.glyph) return <EmptyLine label={result.error ?? "glyph unreachable"} />;
  const glyph: TowerGlyphDetail = result.glyph;
  return <>
    <div className="vellum-modal__eyebrow">glyph / {glyph.state}</div>
    <div className="vellum-modal__title">{glyph.title}</div>
    <div className="vellum-modal__meta">{glyph.orbit} · {glyph.glyphId}</div>
    <div className="vellum-modal__body">
      <pre className="vellum-modal__pre">{glyph.content || "no content"}</pre>
      <ChipRow label="dependencies" values={glyph.dependencies} />
      <ChipRow label="dependents" values={glyph.dependents} />
      {glyph.commentsTotal > 0 ? <div className="mt-3">
        <div className="vellum-modal__section-label">comments · {glyph.commentsTotal}</div>
        {glyph.latestComment ? <div className="vellum-modal__quote">“{glyph.latestComment}”</div> : null}
      </div> : null}
    </div>
  </>;
}

function SignalDetailBody({ target }: { readonly target: Extract<BrowseDetailTarget, { kind: "signal" }> }) {
  const [result, setResult] = useState<TowerSignalReadResult>();
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    // Same never-reject invariant as the glyph fetch above — .catch is a
    // floor, not a path the fetcher is expected to take.
    void fetchTowerSignalRead(target.projectKey, target.orbit, target.signalId)
      .then((value) => { if (!cancelled) setResult(value); })
      .catch(() => { if (!cancelled) setResult({ ok: false, error: "tower unreachable" }); });
    return () => { cancelled = true; };
  }, [target.projectKey, target.orbit, target.signalId]);

  if (!result) return <LoadingLine label="loading signal…" />;
  if (!result.ok || !result.signal) return <EmptyLine label={result.error ?? "signal unreachable"} />;
  const signal: TowerSignalDetail = result.signal;
  return <>
    <div className="vellum-modal__eyebrow">signal / {signal.status}</div>
    <div className="vellum-modal__title">{signal.kind}</div>
    <div className="vellum-modal__body">
      <p className="vellum-modal__paragraph">{signal.summary}</p>
      {signal.priority ? <div className="vellum-modal__line">priority · {signal.priority}</div> : null}
      {signal.sourceName ? <div className="vellum-modal__line">source · {signal.sourceName}</div> : null}
      {signal.consumedBy ? <div className="vellum-modal__line">consumed by · {signal.consumedBy}</div> : null}
      {signal.consumptionSummary ? <div className="vellum-modal__line">{signal.consumptionSummary}</div> : null}
      {signal.payloadJson ? <details className="vellum-modal__details">
        <summary className="vellum-modal__summary">payload</summary>
        <pre className="vellum-modal__pre vellum-modal__pre--small">{signal.payloadJson}</pre>
      </details> : null}
    </div>
  </>;
}

function SessionDetailBody({ target }: { readonly target: Extract<BrowseDetailTarget, { kind: "session" }> }) {
  const [result, setResult] = useState<QuasarSessionDetailResult>();
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    // Same never-reject invariant as the glyph fetch above — .catch is a
    // floor, not a path the fetcher is expected to take.
    void fetchQuasarSessionDetail(target.sessionId)
      .then((value) => { if (!cancelled) setResult(value); })
      .catch(() => { if (!cancelled) setResult({ ok: false, error: "quasar unreachable" }); });
    return () => { cancelled = true; };
  }, [target.sessionId]);

  if (!result) return <LoadingLine label="loading session…" />;
  if (!result.ok || !result.detail) return <EmptyLine label={result.error ?? "session unreachable"} />;
  const detail: QuasarSessionDetail = result.detail;
  return <>
    <div className="vellum-modal__eyebrow">session / {detail.provider}</div>
    <div className="vellum-modal__title">{sessionTitle(detail)}</div>
    <div className="vellum-modal__meta">{sessionDetailStats(detail)}</div>
    <div className="vellum-modal__body">
      {detail.topTools && detail.topTools.length > 0 ? (
        <div className="vellum-modal__chips">{detail.topTools.map((tool) => <span key={tool} className="vellum-modal__chip">{tool}</span>)}</div>
      ) : null}
      {detail.firstUser ? <div className="mt-3">
        <div className="vellum-modal__section-label">first user message</div>
        <div className="vellum-modal__quote vellum-modal__scroll">{detail.firstUser}</div>
      </div> : null}
      {detail.lastAssistant ? <div className="mt-3">
        <div className="vellum-modal__section-label">last assistant message</div>
        <div className="vellum-modal__quote vellum-modal__scroll">{detail.lastAssistant}</div>
      </div> : null}
    </div>
  </>;
}

function DispatchDetailBody({ target }: { readonly target: Extract<BrowseDetailTarget, { kind: "dispatch" }> }) {
  const dispatch = target.dispatch;
  const metaLine = [dispatch.orbit, dispatch.id].filter((part): part is string => Boolean(part)).join(" · ");
  return <>
    <div className="vellum-modal__eyebrow">dispatch{dispatch.status ? ` / ${dispatch.status}` : ""}</div>
    <div className="vellum-modal__title">{dispatch.title}</div>
    {metaLine ? <div className="vellum-modal__meta">{metaLine}</div> : null}
  </>;
}

export function BrowseDetailModal({ target, onClose }: { readonly target: BrowseDetailTarget; readonly onClose: () => void }) {
  return <DetailModal onClose={onClose}>
    {target.kind === "glyph" ? <GlyphDetailBody target={target} /> : null}
    {target.kind === "signal" ? <SignalDetailBody target={target} /> : null}
    {target.kind === "session" ? <SessionDetailBody target={target} /> : null}
    {target.kind === "dispatch" ? <DispatchDetailBody target={target} /> : null}
  </DetailModal>;
}
