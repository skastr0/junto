import { Schema } from "effect";

/** Voice is an attachment to a managed occupant, never an authority credential. */
export const LiveAttention = Schema.Struct({
  canvasName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  selectedNodeIds: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
  viewport: Schema.optional(Schema.Struct({
    x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number,
    zoom: Schema.optional(Schema.Number),
  })),
  draft: Schema.optional(Schema.Struct({
    nodeId: Schema.String,
    text: Schema.String.check(Schema.isMaxLength(4000)),
  })),
});
export type LiveAttention = typeof LiveAttention.Type;

export const LiveStartInput = Schema.Struct({
  canvasName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  offerSdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  attention: LiveAttention,
});
export type LiveStartInput = typeof LiveStartInput.Type;

export const LiveTranscriptEntry = Schema.Struct({
  id: Schema.String,
  speaker: Schema.Literals(["operator", "overseer"]),
  text: Schema.String,
});
export type LiveTranscriptEntry = typeof LiveTranscriptEntry.Type;

export const LiveActionEntry = Schema.Struct({
  id: Schema.String,
  requestId: Schema.String,
  label: Schema.String,
  status: Schema.String,
  targetRefs: Schema.Array(Schema.String),
});
export type LiveActionEntry = typeof LiveActionEntry.Type;

export const LiveRequestEntry = Schema.Struct({
  requestId: Schema.String,
  intentRevision: Schema.Number,
  text: Schema.String,
  status: Schema.String,
});
export type LiveRequestEntry = typeof LiveRequestEntry.Type;

/** Where the live session stands, as the window shows it and the core pushes it on every change. */
export const LiveSnapshot = Schema.Struct({
  sessionId: Schema.NullOr(Schema.String),
  canvasName: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
  connectionEpoch: Schema.Number,
  connection: Schema.Literals(["closed", "connecting", "ready", "disconnected"]),
  authority: Schema.Literals(["active", "revoked"]),
  controller: Schema.Literals(["idle", "interpreting", "working", "waiting-approval"]),
  actionsStopped: Schema.optionalKey(Schema.Boolean),
  elapsedSeconds: Schema.Number,
  voiceCostUsd: Schema.Number,
  limitSeconds: Schema.Number,
  transcript: Schema.Array(LiveTranscriptEntry),
  requests: Schema.Array(LiveRequestEntry),
  actions: Schema.Array(LiveActionEntry),
  message: Schema.optionalKey(Schema.String),
});
export type LiveSnapshot = typeof LiveSnapshot.Type;

export const LiveStartResult = Schema.Struct({
  sessionId: Schema.String,
  connectionEpoch: Schema.Number,
  answerSdp: Schema.String,
  snapshot: LiveSnapshot,
});
export type LiveStartResult = typeof LiveStartResult.Type;

export interface OverseerLiveApi {
  readonly liveStart: (input: LiveStartInput) => Promise<LiveStartResult>;
  readonly liveEnd: (sessionId: string) => Promise<LiveSnapshot>;
  readonly liveSnapshot: () => Promise<LiveSnapshot>;
  readonly liveReady: (sessionId: string, connectionEpoch: number) => Promise<void>;
  readonly liveProviderEvent: (sessionId: string, connectionEpoch: number, event: unknown) => Promise<void>;
  readonly liveAttention: (sessionId: string, attention: LiveAttention) => Promise<void>;
  readonly liveCancel: (sessionId: string, requestId: string) => Promise<LiveSnapshot>;
  readonly liveSteer: (sessionId: string, requestId: string, text: string, attention: LiveAttention) => Promise<LiveSnapshot>;
  readonly liveStopActions: (sessionId: string) => Promise<LiveSnapshot>;
  readonly onLiveChanged: (callback: (snapshot: LiveSnapshot) => void) => () => void;
}
