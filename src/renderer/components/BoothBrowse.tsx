import { useCallback, useEffect, useState } from "react";
import type {
  BoothDraftDetail,
  BoothDraftReadResult,
  BoothDraftRow,
  BoothDraftsResult,
  BoothRequestRow,
  BoothRequestsResult,
  BoothReviewAction,
} from "@shared/ipc";
import {
  draftStatusHue,
  fetchBoothDraftRead,
  orderDrafts,
  postBoothReview,
  requestStatusHue,
} from "../lib/booth-browse";
import { DIM, INK } from "../lib/theme";
import { EmptyLine, LoadingLine } from "./BrowseStatusLine";
import { DetailModal } from "./DetailModal";

// Booth's review cycle inside the inspector: the DRAFTS and REQUESTS tab
// bodies, plus the draft reader modal where the human-in-the-loop actually
// closes the loop — preview the asset, read the thread, leave a verdict.
// Self-contained (own modal state) so the shared browse plumbing stays
// untouched by booth concerns.

const shortDateTime = (epochMs: number): string =>
  new Date(epochMs)
    .toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .toLowerCase();

function Dot({ hue, dim }: { readonly hue: string; readonly dim?: boolean }) {
  return <i className="inline-block size-[5px] shrink-0 rounded-full" style={{ background: hue, opacity: dim ? 0.5 : 1 }} />;
}

// --- drafts tab ---------------------------------------------------------------

function DraftRow({ draft, onOpen }: { readonly draft: BoothDraftRow; readonly onOpen: () => void }) {
  const hue = draftStatusHue(draft.status);
  const settled = draft.status === "superseded" || draft.status === "archived";
  return <button type="button" className="vellum-row-button flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }} onClick={onOpen} aria-label={`Open draft ${draft.title}`}>
    <Dot hue={hue} dim={settled} />
    <span className="shrink-0 uppercase tracking-[.06em]" style={{ color: hue }}>{(draft.status ?? "draft").replace(/_/g, " ")}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={draft.title}>{draft.title}</span>
    {draft.kind ? <span className="shrink-0 uppercase tracking-[.08em]">{draft.kind}</span> : null}
  </button>;
}

export function BoothDraftsTab({
  result,
  loading,
  projectKey,
}: {
  readonly result: BoothDraftsResult | undefined;
  readonly loading: boolean;
  readonly projectKey: string;
}) {
  const [openDraftId, setOpenDraftId] = useState<string>();
  if (loading) return <LoadingLine label="loading drafts…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "booth unreachable"} />;
  if (result.drafts.length === 0) return <EmptyLine label="no drafts" />;
  return <>
    <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
      {orderDrafts(result.drafts).map((draft) => (
        <DraftRow key={draft.id} draft={draft} onOpen={() => setOpenDraftId(draft.id)} />
      ))}
    </div>
    {openDraftId ? (
      <DetailModal onClose={() => setOpenDraftId(undefined)}>
        <DraftDetailBody draftId={openDraftId} projectKey={projectKey} />
      </DetailModal>
    ) : null}
  </>;
}

// --- requests tab ---------------------------------------------------------------

function RequestRow({ request, onOpen }: { readonly request: BoothRequestRow; readonly onOpen: () => void }) {
  const hue = requestStatusHue(request.status);
  return <button type="button" className="vellum-row-button flex items-baseline gap-2 py-1 text-[10px]" style={{ color: DIM }} onClick={onOpen} aria-label={`Open request ${request.title}`}>
    <Dot hue={hue} />
    <span className="shrink-0 uppercase tracking-[.06em]" style={{ color: hue }}>{request.status.replace(/_/g, " ")}</span>
    <span className="min-w-0 flex-1 truncate" style={{ color: INK }} title={request.title}>{request.title}</span>
    <span className="shrink-0 uppercase tracking-[.08em]">{request.assetType}</span>
  </button>;
}

export function BoothRequestsTab({
  result,
  loading,
}: {
  readonly result: BoothRequestsResult | undefined;
  readonly loading: boolean;
}) {
  const [open, setOpen] = useState<BoothRequestRow>();
  if (loading) return <LoadingLine label="loading requests…" />;
  if (!result) return null;
  if (!result.ok) return <EmptyLine label={result.error ?? "booth unreachable"} />;
  if (result.requests.length === 0) return <EmptyLine label="no requests" />;
  return <>
    <div className="nowheel max-h-[260px] overflow-y-auto pr-1">
      {result.requests.map((request) => (
        <RequestRow key={request.id} request={request} onOpen={() => setOpen(request)} />
      ))}
    </div>
    {open ? (
      <DetailModal onClose={() => setOpen(undefined)}>
        <div className="vellum-modal__eyebrow">request / {open.status.replace(/_/g, " ")}</div>
        <div className="vellum-modal__title">{open.title}</div>
        <div className="vellum-modal__meta">
          {[open.assetType, open.requester, shortDateTime(open.updatedAt)].filter(Boolean).join(" · ")}
        </div>
        <div className="vellum-modal__body">
          <p className="vellum-modal__paragraph">{open.briefSummary}</p>
        </div>
      </DetailModal>
    ) : null}
  </>;
}

// --- draft reader: preview + thread + verdict -----------------------------------

// mediaKind names intent; mimeType decides the actual element. A draft whose
// media file is missing on the server (registered but never uploaded) 404s —
// the onError fallback names that instead of leaving a broken image.
function MediaPreview({ detail }: { readonly detail: BoothDraftDetail }) {
  const [failed, setFailed] = useState(false);
  if (!detail.mediaUrl) return null;
  if (failed) return <div className="vellum-modal__line" style={{ color: DIM }}>media unavailable (file missing on booth server)</div>;
  const video = detail.mediaKind === "video" || detail.mimeType?.startsWith("video/") === true;
  return <div className="mt-2 overflow-hidden rounded-md border" style={{ borderColor: "rgba(237,230,218,.14)", background: "rgba(0,0,0,.25)" }}>
    {video ? (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- review preview of a draft asset; booth carries no caption track
      <video src={detail.mediaUrl} controls className="block max-h-[320px] w-full" onError={() => setFailed(true)} />
    ) : (
      <img src={detail.mediaUrl} alt={detail.title} className="block max-h-[320px] w-full object-contain" onError={() => setFailed(true)} />
    )}
  </div>;
}

function ReviewThread({ detail }: { readonly detail: BoothDraftDetail }) {
  if (detail.reviewEvents.length === 0) return null;
  return <div className="mt-3">
    <div className="vellum-modal__section-label">review thread · {detail.reviewEvents.length}</div>
    {detail.reviewEvents.map((event) => (
      <div key={event.id} className="mt-1.5">
        <div className="vellum-modal__line">
          <span style={{ color: draftStatusHue(event.eventType === "approve" ? "approved" : event.eventType === "reject" ? "rejected" : event.eventType === "request_revision" ? "needs_revision" : undefined) }}>
            {event.eventType.replace(/_/g, " ")}
          </span>
          {" · "}{event.actor}{" · "}{shortDateTime(event.createdAt)}
        </div>
        {event.body ? <div className="vellum-modal__quote">“{event.body}”</div> : null}
      </div>
    ))}
  </div>;
}

// The verdict bar: three deliberate writes plus plain comments, sharing one
// note field. approve/reject take the note as optional context;
// request_revision and comment require it (booth 400s a bodyless one — the
// disabled state explains instead of failing).
function VerdictBar({
  projectKey,
  draftId,
  onWrote,
}: {
  readonly projectKey: string;
  readonly draftId: string;
  readonly onWrote: () => void;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<BoothReviewAction>();
  const [status, setStatus] = useState<{ readonly kind: "ok" | "error"; readonly text: string }>();

  const act = async (action: BoothReviewAction) => {
    if (pending) return;
    setPending(action);
    setStatus(undefined);
    const body = note.trim() || undefined;
    const result = await postBoothReview(projectKey, draftId, action, body);
    setPending(undefined);
    if (result.ok) {
      setNote("");
      setStatus({ kind: "ok", text: `${action.replace(/_/g, " ")} recorded` });
      onWrote();
    } else {
      setStatus({ kind: "error", text: result.error ?? `${action} failed` });
    }
  };

  const needsNote = note.trim().length === 0;
  const verdictButton = (action: BoothReviewAction, label: string, hue: string, disabled: boolean) => (
    <button
      type="button"
      className="vellum-modal__comment-submit"
      style={{ color: disabled ? DIM : hue, borderColor: disabled ? undefined : `color-mix(in srgb, ${hue} 45%, transparent)` }}
      disabled={disabled || pending !== undefined}
      onClick={() => void act(action)}
    >
      {pending === action ? "…" : label}
    </button>
  );

  return <div className="vellum-modal__comment">
    <div className="vellum-modal__comment-row">
      <textarea
        className="vellum-modal__comment-input"
        placeholder="review note (required for comment / request revision)…"
        rows={1}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    </div>
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {verdictButton("approve", "approve", "#5FB98E", false)}
      {verdictButton("request_revision", "request revision", "#D9A03F", needsNote)}
      {verdictButton("reject", "reject", "#C25E5E", false)}
      {verdictButton("comment", "comment", "#8A8FBF", needsNote)}
    </div>
    {status ? (
      <div className={`vellum-modal__comment-status vellum-modal__comment-status--${status.kind === "ok" ? "ok" : "error"}`}>
        {status.text}
      </div>
    ) : null}
  </div>;
}

export function DraftDetailBody({ draftId, projectKey }: { readonly draftId: string; readonly projectKey: string }) {
  const [result, setResult] = useState<BoothDraftReadResult>();

  const load = useCallback(() => {
    let cancelled = false;
    // fetchBoothDraftRead never rejects (booth-browse.ts resolves every
    // failure to an { ok: false } result) — .catch is a belt-and-braces
    // floor so the loading line always resolves.
    void fetchBoothDraftRead(draftId)
      .then((value) => { if (!cancelled) setResult(value); })
      .catch(() => { if (!cancelled) setResult({ ok: false, error: "booth unreachable" }); });
    return () => { cancelled = true; };
  }, [draftId]);

  useEffect(() => {
    setResult(undefined);
    return load();
  }, [load]);

  if (!result) return <LoadingLine label="loading draft…" />;
  if (!result.ok || !result.detail) return <EmptyLine label={result.error ?? "draft unreachable"} />;
  const detail = result.detail;
  const meta = [detail.assetType, detail.channel, detail.agentName, shortDateTime(detail.updatedAt)]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return <>
    <div className="vellum-modal__eyebrow" style={{ color: draftStatusHue(detail.status) }}>
      draft / {detail.status.replace(/_/g, " ")}
    </div>
    <div className="vellum-modal__title">{detail.title}</div>
    <div className="vellum-modal__meta">{meta}</div>
    <div className="vellum-modal__body">
      <MediaPreview detail={detail} />
      {detail.bodyText ? <pre className="vellum-modal__pre mt-2">{detail.bodyText}</pre> : null}
      {detail.captionText ? <div className="mt-2">
        <div className="vellum-modal__section-label">caption</div>
        <div className="vellum-modal__quote">“{detail.captionText}”</div>
      </div> : null}
      <ReviewThread detail={detail} />
      <VerdictBar projectKey={projectKey} draftId={draftId} onWrote={() => { setResult(undefined); load(); }} />
    </div>
  </>;
}
