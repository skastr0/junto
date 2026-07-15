import { Context, Effect, Either } from "effect";
import { TowerClient } from "@skastr0/tower-sdk";
import type {
  SourceWriteResult,
  TowerBrowseResult,
  TowerDispatchesResult,
  TowerEmitSignalInput,
  TowerEmitSignalResult,
  TowerGlyphDetail,
  TowerGlyphReadResult,
  TowerGlyphRow,
  TowerSearchMatch,
  TowerSearchResult,
  TowerSignalDetail,
  TowerSignalPriority,
  TowerSignalReadResult,
  TowerSignalRow,
} from "@shared/ipc";
import { runSdkGuarded, SdkRuntime } from "./sdk-runtime";
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

// Defaults mirror tower-cli `signal emit` (contract → signal/v1, payload → {}).
export const DEFAULT_SIGNAL_CONTRACT = "signal/v1";

// Tower signal kind: lowercase lead, then alnum / . _ - segments.
const SIGNAL_KIND_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
// Contract schema id ends in /vN (tower SignalContractSchemaId).
const SIGNAL_CONTRACT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*\/v[0-9]+$/;
const SIGNAL_ORBIT_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SIGNAL_PRIORITIES: ReadonlyArray<TowerSignalPriority> = ["low", "normal", "high", "urgent"];

export interface ParsedEmitSignalInput {
  readonly projectKey: string;
  readonly orbit: string;
  readonly kind: string;
  readonly summary: string;
  readonly contractSchemaId: string;
  readonly payload: Record<string, unknown>;
  readonly priority?: TowerSignalPriority;
  readonly dedupeKey?: string;
}

export type ParsedEmitSignal =
  | { readonly ok: true; readonly input: ParsedEmitSignalInput }
  | { readonly ok: false; readonly error: string };

// Pure validation for deliberate signal emit. Keeps network out of the loop
// for empty/malformed forms (same role as isBlankCommentBody for comments).
export const parseEmitSignalInput = (raw: TowerEmitSignalInput): ParsedEmitSignal => {
  const projectKey = raw.projectKey.trim();
  if (!projectKey) return { ok: false, error: "project key is required" };

  const orbit = raw.orbit.trim();
  if (!orbit) return { ok: false, error: "orbit is required" };
  if (!SIGNAL_ORBIT_RE.test(orbit)) {
    return { ok: false, error: "orbit must be lowercase alphanumeric (with hyphens)" };
  }

  const kind = raw.kind.trim();
  if (!kind) return { ok: false, error: "kind is required" };
  if (!SIGNAL_KIND_RE.test(kind)) {
    return { ok: false, error: "kind must match e.g. note or handoff.request" };
  }

  const summary = raw.summary.trim();
  if (!summary) return { ok: false, error: "summary is required" };

  const contractSchemaId = (raw.contractSchemaId ?? "").trim() || DEFAULT_SIGNAL_CONTRACT;
  if (!SIGNAL_CONTRACT_RE.test(contractSchemaId)) {
    return { ok: false, error: "contract must end in /vN (e.g. signal/v1)" };
  }

  const payloadText = (raw.payloadJson ?? "").trim();
  let payload: Record<string, unknown> = {};
  if (payloadText) {
    try {
      const parsed: unknown = JSON.parse(payloadText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "payload must be a JSON object" };
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: "payload is not valid JSON" };
    }
  }

  const priority = raw.priority;
  if (priority !== undefined && !SIGNAL_PRIORITIES.includes(priority)) {
    return { ok: false, error: "priority must be low, normal, high, or urgent" };
  }

  const dedupeKey = (raw.dedupeKey ?? "").trim() || undefined;

  return {
    ok: true,
    input: {
      projectKey,
      orbit,
      kind,
      summary,
      contractSchemaId,
      payload,
      ...(priority !== undefined ? { priority } : {}),
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
    },
  };
};

// --- browse (fan-out over the 5 orbits, glyphs+signals each) --------------

interface OrbitFetchResult {
  readonly glyphs: ReadonlyArray<TowerGlyphRow>;
  readonly signals: ReadonlyArray<TowerSignalRow>;
  // The two facets are tracked SEPARATELY. Collapsing them into one
  // `succeeded = glyphOk || signalOk` hid the case that matters: glyphs failed
  // but signals answered still read as "this orbit succeeded", so the missing
  // glyphs were treated as authoritative (a glyphs_done watcher could see
  // fewer done glyphs than reality and mis-fire). Each facet's own ok flag
  // lets the caller mark the whole read partial when ANY facet fails.
  readonly glyphsOk: boolean;
  readonly signalsOk: boolean;
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
      glyphsOk: Either.isRight(glyphResult),
      signalsOk: Either.isRight(signalResult),
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
    // Total outage only when EVERY facet of EVERY orbit failed — the 10
    // requests (5 orbits x glyphs+signals) all down — which stays distinct
    // from a legitimately empty project (all ok, all empty).
    const allFailed = perOrbit.every((entry) => !entry.glyphsOk && !entry.signalsOk);
    if (allFailed) {
      return { ok: false, error: ALL_REQUESTS_FAILED_ERROR, glyphs: [], signals: [] };
    }
    // ANY facet of ANY orbit failing makes the read partial: glyphs/signals
    // only cover the facets that answered, so this ok:true result
    // under-reports what a healthy gateway would return. `partial` makes that
    // explicit and additive rather than silent — a caller that needs
    // authoritative counts (the kernel's glyph-cache fetcher) must be able to
    // tell this apart from a genuinely complete read. Tracked per facet so a
    // glyphs-failed/signals-ok orbit is NOT mistaken for complete.
    const partial = perOrbit.some((entry) => !entry.glyphsOk || !entry.signalsOk);
    return {
      ok: true,
      glyphs: perOrbit.flatMap((entry) => entry.glyphs),
      signals: perOrbit.flatMap((entry) => entry.signals),
      ...(partial ? { partial: true } : {}),
    };
  });

export const fetchTowerBrowse = (projectKey: string): Promise<TowerBrowseResult> =>
  runSdkGuarded(
    () => SdkRuntime.runPromise(towerBrowseRows(projectKey)),
    (error) => ({ ok: false, error, glyphs: [], signals: [] }),
  );

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
  runSdkGuarded(
    () => SdkRuntime.runPromise(towerSearchMatches(query, projectKey)),
    (error) => ({ ok: false, error, matches: [] }),
  );

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
): Promise<TowerGlyphReadResult> =>
  runSdkGuarded(
    () => SdkRuntime.runPromise(towerGlyphRead(projectKey, orbit, glyphId)),
    (error) => ({ ok: false, error }),
  );

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
): Promise<TowerSignalReadResult> =>
  runSdkGuarded(
    () => SdkRuntime.runPromise(towerSignalRead(projectKey, orbit, signalId)),
    (error) => ({ ok: false, error }),
  );

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
    : runSdkGuarded(
        () => SdkRuntime.runPromise(towerComment(projectKey, "glyphs", orbit, glyphId, body)),
        (error) => ({ ok: false, error }),
      );

export const fetchTowerCommentSignal = (
  projectKey: string,
  orbit: string,
  signalId: string,
  body: string,
): Promise<SourceWriteResult> =>
  isBlankCommentBody(body)
    ? Promise.resolve({ ok: false, error: "comment body is empty" })
    : runSdkGuarded(
        () => SdkRuntime.runPromise(towerComment(projectKey, "signals", orbit, signalId, body)),
        (error) => ({ ok: false, error }),
      );

// --- signal emit (deliberate write) ----------------------------------------
// User-initiated only. Validation runs before the SDK so blank/malformed
// forms never touch the network.

const towerEmitSignal = (
  input: ParsedEmitSignalInput,
): Effect.Effect<TowerEmitSignalResult, never, TowerClient> =>
  Effect.gen(function* () {
    const tower = yield* TowerClient;
    const result = yield* Effect.either(
      resolved(
        tower.emitSignal({
          projectKey: input.projectKey,
          orbit: input.orbit,
          kind: input.kind,
          contractSchemaId: input.contractSchemaId,
          summary: input.summary,
          payload: input.payload,
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
        }),
      ),
    );
    if (Either.isLeft(result)) {
      return { ok: false, error: `tower emit failed: ${describeSdkError(result.left)}` };
    }
    return { ok: true, signalId: result.right.signalId };
  });

export const fetchTowerEmitSignal = (raw: TowerEmitSignalInput): Promise<TowerEmitSignalResult> => {
  const parsed = parseEmitSignalInput(raw);
  if (!parsed.ok) return Promise.resolve({ ok: false, error: parsed.error });
  return runSdkGuarded(
    () => SdkRuntime.runPromise(towerEmitSignal(parsed.input)),
    (error) => ({ ok: false, error }),
  );
};
