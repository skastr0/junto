import type {
  BoothDraftReadResult,
  BoothDraftsResult,
  BoothRequestsResult,
  BoothReviewAction,
  SourceWriteResult,
} from "@shared/ipc";
import { DIM, HUE } from "./theme";
import { getVellumApi } from "./vellum-api";

// Booth's review-cycle surface for the inspector: pure presentation helpers
// plus cached, defensive fetchers, mirroring lib/browse.ts. Kept in its own
// module — booth logic never entangles the tower/quasar browse plumbing.

// Booth's draft status vocabulary in review-flow order. ready_for_review is
// the attention state — a human verdict is owed.
export const DRAFT_STATUS_ORDER = [
  "ready_for_review",
  "needs_revision",
  "approved",
  "rejected",
  "superseded",
  "archived",
] as const;

export const draftStatusHue = (status: string | undefined): string => {
  if (status === "ready_for_review") return HUE.amber;
  if (status === "needs_revision") return HUE.cyan;
  if (status === "approved") return "#5FB98E";
  if (status === "rejected") return HUE.crimson;
  return DIM; // superseded, archived, and anything unknown
};

export const requestStatusHue = (status: string): string => {
  if (status === "open" || status === "in_progress") return HUE.amber;
  if (status === "in_review") return HUE.cyan;
  if (status === "approved") return "#5FB98E";
  return DIM; // closed, archived
};

// Attention-first ordering: statuses awaiting the human float up, settled
// ones sink, ties break newest-first.
export const orderDrafts = <T extends { readonly status?: string; readonly updatedAt?: string }>(
  drafts: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const order: ReadonlyArray<string> = DRAFT_STATUS_ORDER;
  const rank = (status: string | undefined): number => {
    const index = order.indexOf(status ?? "");
    return index === -1 ? order.length : index;
  };
  return drafts.slice().sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
};

// The two verdict-adjacent actions that booth's server 400s without a body —
// pre-flighted in the adapter, mirrored here so the UI can gate its controls.
export const reviewActionNeedsBody = (action: BoothReviewAction): boolean =>
  action === "comment" || action === "request_revision";

// --- cached, defensive fetchers ---------------------------------------------
// Same contract as lib/browse.ts fetchers: never reject, short TTL, and a
// verdict write evicts what it mutated.

const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  readonly value: T;
  readonly at: number;
}

const draftsCache = new Map<string, CacheEntry<BoothDraftsResult>>();
const draftReadCache = new Map<string, CacheEntry<BoothDraftReadResult>>();
const requestsCache = new Map<string, CacheEntry<BoothRequestsResult>>();

const cacheGet = <T,>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) return undefined;
  return hit.value;
};

const DRAFTS_UNREACHABLE: BoothDraftsResult = { ok: false, error: "booth unreachable", drafts: [] };
const DRAFT_READ_UNREACHABLE: BoothDraftReadResult = { ok: false, error: "booth unreachable" };
const REQUESTS_UNREACHABLE: BoothRequestsResult = { ok: false, error: "booth unreachable", requests: [] };
const WRITE_UNREACHABLE: SourceWriteResult = { ok: false, error: "booth unreachable" };

export const fetchBoothDrafts = async (projectKey: string): Promise<BoothDraftsResult> => {
  const cached = cacheGet(draftsCache, projectKey);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.boothDrafts !== "function") return DRAFTS_UNREACHABLE;
  try {
    const result = await api.boothDrafts(projectKey);
    draftsCache.set(projectKey, { value: result, at: Date.now() });
    return result;
  } catch {
    return DRAFTS_UNREACHABLE;
  }
};

export const fetchBoothDraftRead = async (draftId: string): Promise<BoothDraftReadResult> => {
  const cached = cacheGet(draftReadCache, draftId);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.boothDraftRead !== "function") return DRAFT_READ_UNREACHABLE;
  try {
    const result = await api.boothDraftRead(draftId);
    draftReadCache.set(draftId, { value: result, at: Date.now() });
    return result;
  } catch {
    return DRAFT_READ_UNREACHABLE;
  }
};

export const fetchBoothRequests = async (projectKey: string): Promise<BoothRequestsResult> => {
  const cached = cacheGet(requestsCache, projectKey);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.boothRequests !== "function") return REQUESTS_UNREACHABLE;
  try {
    const result = await api.boothRequests(projectKey);
    requestsCache.set(projectKey, { value: result, at: Date.now() });
    return result;
  } catch {
    return REQUESTS_UNREACHABLE;
  }
};

// A verdict/comment mutates the draft's status and thread — evict the draft's
// detail and the project's list so the next read reflects the write instead
// of a stale entry inside the TTL window.
export const postBoothReview = async (
  projectKey: string,
  draftId: string,
  action: BoothReviewAction,
  body?: string,
): Promise<SourceWriteResult> => {
  const api = getVellumApi();
  if (!api || typeof api.boothReview !== "function") return WRITE_UNREACHABLE;
  try {
    const result = await api.boothReview(projectKey, draftId, action, body);
    if (result.ok) {
      draftReadCache.delete(draftId);
      draftsCache.delete(projectKey);
    }
    return result;
  } catch {
    return WRITE_UNREACHABLE;
  }
};
