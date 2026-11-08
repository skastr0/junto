/** Session-relative provider times are evidence intervals, never turn boundaries. */
export interface LiveTranscriptFragment {
  readonly eventId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface LiveDelegation {
  readonly eventId: string;
  readonly delegationId: string;
  readonly offsetMs: number;
}

export const LIVE_TRANSCRIPT_LIMITS = Object.freeze({
  fragments: 512,
  transcriptBytes: 65_536,
  fragmentBytes: 16_384,
  eventIds: 16_384,
  delegations: 1_024,
});

/**
 * Dedupe identities outlive the rolling text window. At capacity the caller
 * must end the session, rather than forget identities and replay old requests.
 */
export interface LiveTranscriptJournal {
  readonly fragments: ReadonlyArray<LiveTranscriptFragment>;
  readonly seenEventIds: ReadonlyArray<string>;
  readonly delegationIds: ReadonlyArray<string>;
  readonly delegatedTranscriptIds: ReadonlyArray<string>;
  readonly previousDelegationOffsetMs: number | null;
  readonly historyTruncated: boolean;
}

export interface LiveDelegatedTranscript<Context> {
  readonly delegationId: string;
  readonly offsetMs: number;
  readonly previousDelegationOffsetMs: number | null;
  /** Prior operator fragments remain present so a correction has its referent. */
  readonly requestText: string;
  readonly transcriptRefs: ReadonlyArray<LiveTranscriptFragment>;
  readonly newTranscriptRefs: ReadonlyArray<LiveTranscriptFragment>;
  readonly historyTruncated: boolean;
  readonly context: Context;
}

type Rejection = "duplicate" | "invalid" | "capacity";

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const validOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The Live wire emits deltas, without item ids or a final-transcript marker. */
export const decodeLiveTranscriptEvent = (value: unknown): LiveTranscriptFragment | null => {
  if (!record(value) ||
    (value.type !== "session.input_transcript.delta" && value.type !== "session.output_transcript.delta") ||
    !validId(value.event_id) || typeof value.delta !== "string" ||
    !validOffset(value.start_ms) || !validOffset(value.end_ms) || value.end_ms < value.start_ms ||
    Buffer.byteLength(value.delta, "utf8") > LIVE_TRANSCRIPT_LIMITS.fragmentBytes) return null;
  return Object.freeze({
    eventId: value.event_id,
    role: value.type === "session.input_transcript.delta" ? "user" : "assistant",
    text: value.delta,
    startMs: value.start_ms,
    endMs: value.end_ms,
  });
};

/** No task text is present in this event. Never synthesize a request from it. */
export const decodeLiveDelegationEvent = (value: unknown): LiveDelegation | null => {
  if (!record(value) || value.type !== "session.delegation.created" ||
    !validId(value.event_id) || !validOffset(value.offset_ms) ||
    !record(value.delegation) || !validId(value.delegation.id) ||
    value.delegation.type !== "delegation" || value.delegation.target !== "client") return null;
  return Object.freeze({
    eventId: value.event_id,
    delegationId: value.delegation.id,
    offsetMs: value.offset_ms,
  });
};

const freezeJournal = (journal: LiveTranscriptJournal): LiveTranscriptJournal => Object.freeze({
  ...journal,
  fragments: Object.freeze(journal.fragments),
  seenEventIds: Object.freeze(journal.seenEventIds),
  delegationIds: Object.freeze(journal.delegationIds),
  delegatedTranscriptIds: Object.freeze(journal.delegatedTranscriptIds),
});

export const createTranscriptJournal = (): LiveTranscriptJournal => freezeJournal({
  fragments: [], seenEventIds: [], delegationIds: [], delegatedTranscriptIds: [],
  previousDelegationOffsetMs: null, historyTruncated: false,
});

/** Recording speech has no request, operation, or authoring side effect. */
export const appendTranscript = (
  journal: LiveTranscriptJournal,
  fragment: LiveTranscriptFragment,
): { readonly journal: LiveTranscriptJournal; readonly accepted: boolean; readonly reason?: Rejection } => {
  if (!validId(fragment.eventId) || !validOffset(fragment.startMs) || !validOffset(fragment.endMs) ||
    fragment.endMs < fragment.startMs || (fragment.role !== "user" && fragment.role !== "assistant") ||
    typeof fragment.text !== "string" || Buffer.byteLength(fragment.text, "utf8") > LIVE_TRANSCRIPT_LIMITS.fragmentBytes) {
    return { journal, accepted: false, reason: "invalid" };
  }
  if (journal.seenEventIds.includes(fragment.eventId)) return { journal, accepted: false, reason: "duplicate" };
  if (journal.seenEventIds.length >= LIVE_TRANSCRIPT_LIMITS.eventIds) return { journal, accepted: false, reason: "capacity" };
  const fragments = [...journal.fragments, Object.freeze({ ...fragment })];
  let bytes = fragments.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0);
  let dropped = 0;
  while (fragments.length - dropped > LIVE_TRANSCRIPT_LIMITS.fragments || bytes > LIVE_TRANSCRIPT_LIMITS.transcriptBytes) {
    bytes -= Buffer.byteLength(fragments[dropped++]!.text, "utf8");
  }
  return {
    accepted: true,
    journal: freezeJournal({
      ...journal,
      fragments: fragments.slice(dropped),
      seenEventIds: [...journal.seenEventIds, fragment.eventId],
      historyTruncated: journal.historyTruncated || dropped > 0,
    }),
  };
};

const freezeSnapshot = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Capture at delegation, not after a backend round trip. Text is assembled from
 * received input deltas only; overlapping time ranges do not mean duplicate
 * text. A delta crossing the offset is included whole because its words have
 * no individual timestamps. The backend receives that exact evidence interval.
 */
export const captureLiveDelegation = <Context>(
  journal: LiveTranscriptJournal,
  delegation: LiveDelegation,
  context: Context,
): {
  readonly journal: LiveTranscriptJournal;
  readonly request?: LiveDelegatedTranscript<Context>;
  readonly reason?: Rejection | "empty" | "stale";
} => {
  if (!validId(delegation.eventId) || !validId(delegation.delegationId) || !validOffset(delegation.offsetMs)) {
    return { journal, reason: "invalid" };
  }
  if (journal.seenEventIds.includes(delegation.eventId) || journal.delegationIds.includes(delegation.delegationId)) {
    return { journal, reason: "duplicate" };
  }
  if (journal.seenEventIds.length >= LIVE_TRANSCRIPT_LIMITS.eventIds ||
    journal.delegationIds.length >= LIVE_TRANSCRIPT_LIMITS.delegations) return { journal, reason: "capacity" };

  const transcriptRefs = journal.fragments.filter((fragment) => fragment.role === "user" &&
    (fragment.startMs < delegation.offsetMs || (fragment.startMs === delegation.offsetMs && fragment.endMs === fragment.startMs)))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const delegatedIds = new Set(journal.delegatedTranscriptIds);
  const newTranscriptRefs = transcriptRefs.filter((fragment) => !delegatedIds.has(fragment.eventId));
  const stale = journal.previousDelegationOffsetMs !== null && delegation.offsetMs < journal.previousDelegationOffsetMs;
  const next = freezeJournal({
    ...journal,
    seenEventIds: [...journal.seenEventIds, delegation.eventId],
    delegationIds: [...journal.delegationIds, delegation.delegationId],
    delegatedTranscriptIds: stale ? journal.delegatedTranscriptIds :
      [...journal.delegatedTranscriptIds, ...newTranscriptRefs.map((fragment) => fragment.eventId)],
    previousDelegationOffsetMs: Math.max(journal.previousDelegationOffsetMs ?? 0, delegation.offsetMs),
  });
  if (stale) return { journal: next, reason: "stale" };
  if (!newTranscriptRefs.some((fragment) => fragment.text.trim().length > 0)) return { journal: next, reason: "empty" };
  return {
    journal: next,
    request: freezeSnapshot({
      delegationId: delegation.delegationId,
      offsetMs: delegation.offsetMs,
      previousDelegationOffsetMs: journal.previousDelegationOffsetMs,
      requestText: transcriptRefs.map((fragment) => fragment.text).join(""),
      transcriptRefs,
      newTranscriptRefs,
      historyTruncated: journal.historyTruncated,
      context: structuredClone(context),
    }),
  };
};
