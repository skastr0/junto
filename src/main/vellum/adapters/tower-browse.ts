import { Context, Effect, Either } from "effect";
import { TowerClient } from "@skastr0/tower-sdk";
import type {
  SourceWriteResult,
  TowerBrowseResult,
  TowerDispatchesResult,
  TowerGlyphDetail,
  TowerGlyphReadResult,
  TowerGlyphRow,
  TowerSearchMatch,
  TowerSearchResult,
  TowerSignalDetail,
  TowerSignalReadResult,
  TowerSignalRow,
} from "@shared/ipc";
import { SdkRuntime } from "./sdk-runtime";
import { describeSdkError } from "./sdk-errors";
import { resolved } from "./tower-client";

// Read-only tower-control browse/search adapter. Talks to the live gateway
// through @skastr0/tower-sdk's TowerClient — no hand-rolled fetch, no
// manual config-file loading, no Raw* interfaces. Effect Schema decode at
// the SDK boundary already validated every shape below; this file only
// projects the SDK's typed rows onto the frozen IPC contract the renderer
// consumes (kept byte-identical).

type TowerClientService = Context.Tag.Service<typeof TowerClient>;

// The row/detail/search shapes below are explicit permissive interfaces
// (narrowed to exactly what each mapper reads), not Pick<> chains off the
// SDK's real nested return types — a Pick<Effect.Effect.Success<ReturnType<
// TowerClientService["x"]>>, ...> chain is a lot of type indirection for a
// handful of flat fields, and every real SDK-decoded value structurally
// satisfies these narrower interfaces anyway (extra fields are just
// ignored). Same reasoning as quasar.ts's mapper-facing row types.

interface SdkGlyphRow {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string;
  readonly updatedAt: number;
}

interface SdkSignalRow {
  readonly signalId: string;
  readonly orbit: string;
  readonly status: string;
  readonly kind: string;
  readonly summary: string;
  readonly priority?: string;
  readonly updatedAt: number;
}

interface SdkSearchSourceRef {
  readonly family: string;
  readonly signalId?: string;
}

interface SdkSearchMatchRow {
  readonly family: string;
  readonly title: string;
  readonly summary?: string;
  readonly projectKey: string;
  readonly orbit?: string;
  readonly glyphId?: string;
  readonly state?: string;
  readonly status?: string;
  readonly score: number;
  readonly sourceRef: SdkSearchSourceRef;
}

interface SdkGlyphDetail {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string;
  readonly content: string;
  readonly comments?: { readonly total: number; readonly latest?: ReadonlyArray<{ readonly body: string }> };
  readonly dependencies: ReadonlyArray<{ readonly to: { readonly glyphId: string } }>;
  readonly dependents: ReadonlyArray<{ readonly from: { readonly glyphId: string } }>;
  readonly updatedAt: number;
}

interface SdkSignalDetail {
  readonly signalId: string;
  readonly orbit: string;
  readonly status: string;
  readonly kind: string;
  readonly summary: string;
  readonly priority?: string;
  readonly payload?: unknown;
  readonly source?: { readonly name?: string };
  readonly audit: { readonly consumed_by?: string; readonly consumption_summary?: string };
  readonly updatedAt: number;
}

// The gateway only serves these five orbits; browse fans out across all of
// them per projectKey.
const ORBITS = ["forge", "survey", "beacon", "scribe", "oracle"] as const;

// --- pure mappers (frozen IPC contract; unit-testable with no runtime) ----

export const mapGlyphItems = (items: ReadonlyArray<SdkGlyphRow> | undefined): ReadonlyArray<TowerGlyphRow> => {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    glyphId: item.glyphId,
    orbit: item.orbit,
    title: item.title,
    state: item.state,
    updatedAt: item.updatedAt,
  }));
};

export const mapSignalItems = (items: ReadonlyArray<SdkSignalRow> | undefined): ReadonlyArray<TowerSignalRow> => {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    signalId: item.signalId,
    orbit: item.orbit,
    status: item.status,
    kind: item.kind,
    summary: item.summary,
    priority: item.priority,
    updatedAt: item.updatedAt,
  }));
};

// The SDK's SearchMatch carries no flat `signalId` (unlike the old hand-rolled
// fetch shape) — the signal's id only lives inside `sourceRef` when
// sourceRef.family === "signals". Pull it out there so the frozen
// TowerSearchMatch.signalId field keeps working for the renderer.
const extractSignalId = (match: SdkSearchMatchRow): string | undefined =>
  match.sourceRef.family === "signals" ? match.sourceRef.signalId : undefined;

export const mapSearchMatches = (
  matches: ReadonlyArray<SdkSearchMatchRow> | undefined,
): ReadonlyArray<TowerSearchMatch> => {
  if (!Array.isArray(matches)) return [];
  return matches.map((match) => ({
    family: match.family,
    title: match.title,
    summary: match.summary,
    projectKey: match.projectKey,
    orbit: match.orbit,
    glyphId: match.glyphId,
    signalId: extractSignalId(match),
    state: match.state,
    status: match.status,
    score: match.score,
  }));
};

export const mapGlyphDetail = (raw: SdkGlyphDetail): TowerGlyphDetail => ({
  glyphId: raw.glyphId,
  orbit: raw.orbit,
  title: raw.title,
  state: raw.state,
  content: raw.content ?? "",
  commentsTotal: raw.comments?.total ?? 0,
  latestComment: raw.comments?.latest?.[0]?.body,
  dependencies: (raw.dependencies ?? []).map((edge) => edge.to.glyphId),
  dependents: (raw.dependents ?? []).map((edge) => edge.from.glyphId),
  updatedAt: raw.updatedAt,
});

const PAYLOAD_JSON_CAP = 20_000;

export const formatPayloadJson = (payload: unknown): string | undefined => {
  if (payload === undefined) return undefined;
  const full = JSON.stringify(payload, null, 2);
  return full.length > PAYLOAD_JSON_CAP ? `${full.slice(0, PAYLOAD_JSON_CAP)}… (truncated)` : full;
};

export const mapSignalDetail = (raw: SdkSignalDetail): TowerSignalDetail => ({
  signalId: raw.signalId,
  orbit: raw.orbit,
  status: raw.status,
  kind: raw.kind,
  summary: raw.summary,
  priority: raw.priority,
  payloadJson: formatPayloadJson(raw.payload),
  sourceName: raw.source?.name,
  consumedBy: raw.audit?.consumed_by,
  consumptionSummary: raw.audit?.consumption_summary,
  updatedAt: raw.updatedAt,
});

export const isBlankCommentBody = (body: string): boolean => body.trim().length === 0;

// --- browse (fan-out over the 5 orbits, glyphs+signals each) --------------

interface OrbitFetchResult {
  readonly glyphs: ReadonlyArray<TowerGlyphRow>;
  readonly signals: ReadonlyArray<TowerSignalRow>;
  // true when at least one of the orbit's two calls actually succeeded —
  // false means both failed for this orbit.
  readonly succeeded: boolean;
}

const fetchOrbit = (
  tower: TowerClientService,
  projectKey: string,
  orbit: string,
): Effect.Effect<OrbitFetchResult> =>
  Effect.gen(function* () {
    const [glyphResult, signalResult] = yield* Effect.all(
      [
        Effect.either(resolved(tower.listGlyphs({ projectKey, orbit }))),
        Effect.either(resolved(tower.listSignals({ projectKey, orbit }))),
      ],
      { concurrency: "unbounded" },
    );
    return {
      glyphs: Either.isRight(glyphResult) ? mapGlyphItems(glyphResult.right.items) : [],
      signals: Either.isRight(signalResult) ? mapSignalItems(signalResult.right.signals) : [],
      succeeded: Either.isRight(glyphResult) || Either.isRight(signalResult),
    };
  });

const ALL_REQUESTS_FAILED_ERROR = "tower gateway unreachable — every glyph/signal request failed";

// The testable unit: requires only TowerClient. Fans the 5 orbits x
// (glyphs+signals) in parallel; a failing orbit contributes nothing and this
// program itself never fails — but every one of the 10 requests failing
// must NOT read as "this project has zero glyphs/signals" (distinguishes a
// down gateway from a legitimately empty project).
export const towerBrowseRows = (
  projectKey: string,
): Effect.Effect<TowerBrowseResult, never, TowerClient> =>
  Effect.gen(function* () {
    const tower = yield* TowerClient;
    const perOrbit = yield* Effect.all(
      ORBITS.map((orbit) => fetchOrbit(tower, projectKey, orbit)),
      { concurrency: "unbounded" },
    );
    const allFailed = perOrbit.every((entry) => !entry.succeeded);
    if (allFailed) {
      return { ok: false, error: ALL_REQUESTS_FAILED_ERROR, glyphs: [], signals: [] };
    }
    return {
      ok: true,
      glyphs: perOrbit.flatMap((entry) => entry.glyphs),
      signals: perOrbit.flatMap((entry) => entry.signals),
    };
  });

export const fetchTowerBrowse = (projectKey: string): Promise<TowerBrowseResult> =>
  SdkRuntime.runPromise(towerBrowseRows(projectKey));

// --- search (POST /api/search/text) ----------------------------------------

const SEARCH_LIMIT = 20;

export const towerSearchMatches = (
  query: string,
  projectKey?: string,
): Effect.Effect<TowerSearchResult, never, TowerClient> =>
  Effect.gen(function* () {
    const tower = yield* TowerClient;
    const result = yield* Effect.either(
      resolved(tower.search({ mode: "text", query, projectKey, limit: SEARCH_LIMIT })),
    );
    if (Either.isLeft(result)) {
      return { ok: false, error: describeSdkError(result.left), matches: [] };
    }
    return { ok: true, matches: mapSearchMatches(result.right.matches) };
  });

export const fetchTowerSearch = (query: string, projectKey?: string): Promise<TowerSearchResult> =>
  SdkRuntime.runPromise(towerSearchMatches(query, projectKey));

// --- glyph detail (reader modal) --------------------------------------------

export const towerGlyphRead = (
  projectKey: string,
  orbit: string,
  glyphId: string,
): Effect.Effect<TowerGlyphReadResult, never, TowerClient> =>
  Effect.gen(function* () {
    const tower = yield* TowerClient;
    const result = yield* Effect.either(resolved(tower.readGlyph({ projectKey, orbit, glyphId })));
    if (Either.isLeft(result)) {
      return { ok: false, error: describeSdkError(result.left) };
    }
    return { ok: true, glyph: mapGlyphDetail(result.right) };
  });

export const fetchTowerGlyphRead = (
  projectKey: string,
  orbit: string,
  glyphId: string,
): Promise<TowerGlyphReadResult> => SdkRuntime.runPromise(towerGlyphRead(projectKey, orbit, glyphId));

// --- signal detail (reader modal) -------------------------------------------

export const towerSignalRead = (
  projectKey: string,
  orbit: string,
  signalId: string,
): Effect.Effect<TowerSignalReadResult, never, TowerClient> =>
  Effect.gen(function* () {
    const tower = yield* TowerClient;
    const result = yield* Effect.either(resolved(tower.readSignal({ projectKey, orbit, signalId })));
    if (Either.isLeft(result)) {
      return { ok: false, error: describeSdkError(result.left) };
    }
    return { ok: true, signal: mapSignalDetail(result.right) };
  });

export const fetchTowerSignalRead = (
  projectKey: string,
  orbit: string,
  signalId: string,
): Promise<TowerSignalReadResult> => SdkRuntime.runPromise(towerSignalRead(projectKey, orbit, signalId));

// --- dispatches (no confirmed live browse route — see tower-cli's SDK,
// which never wires a GET /api/dispatches route either) --------------------

export const fetchTowerDispatches = (_projectKey: string): Promise<TowerDispatchesResult> =>
  Promise.resolve({ ok: false, error: "unsupported", dispatches: [] });

// --- comments (deliberate write) --------------------------------------------
// Narrow, user-initiated, never automatic, never retried, never batched.

const towerComment = (
  projectKey: string,
  family: "glyphs" | "signals",
  orbit: string,
  id: string,
  body: string,
): Effect.Effect<SourceWriteResult, never, TowerClient> =>
  Effect.gen(function* () {
    if (isBlankCommentBody(body)) {
      return { ok: false, error: "comment body is empty" };
    }
    const tower = yield* TowerClient;
    const result = yield* Effect.either(
      resolved(
        tower.createComment({
          projectKey,
          family,
          id,
          orbit,
          body: body.trim(),
          provenance: { source: "agent", actor: "vellum" },
        }),
      ),
    );
    if (Either.isLeft(result)) {
      return { ok: false, error: `tower comment failed: ${describeSdkError(result.left)}` };
    }
    return { ok: true };
  });

export const fetchTowerCommentGlyph = (
  projectKey: string,
  orbit: string,
  glyphId: string,
  body: string,
): Promise<SourceWriteResult> =>
  isBlankCommentBody(body)
    ? Promise.resolve({ ok: false, error: "comment body is empty" })
    : SdkRuntime.runPromise(towerComment(projectKey, "glyphs", orbit, glyphId, body));

export const fetchTowerCommentSignal = (
  projectKey: string,
  orbit: string,
  signalId: string,
  body: string,
): Promise<SourceWriteResult> =>
  isBlankCommentBody(body)
    ? Promise.resolve({ ok: false, error: "comment body is empty" })
    : SdkRuntime.runPromise(towerComment(projectKey, "signals", orbit, signalId, body));
