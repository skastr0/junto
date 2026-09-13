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

export interface LiveTranscriptEntry {
  readonly id: string;
  readonly speaker: "operator" | "overseer";
  readonly text: string;
}
export interface LiveActionEntry {
  readonly id: string;
  readonly requestId: string;
  readonly label: string;
  readonly status: string;
  readonly targetRefs: ReadonlyArray<string>;
}
export interface LiveRequestEntry {
  readonly requestId: string;
  readonly intentRevision: number;
  readonly text: string;
  readonly status: string;
}
export interface LiveSnapshot {
  readonly sessionId: string | null;
  readonly canvasName: string | null;
  readonly nodeId: string | null;
  readonly connectionEpoch: number;
  readonly connection: "closed" | "connecting" | "ready" | "disconnected";
  readonly authority: "active" | "revoked";
  readonly controller: "idle" | "interpreting" | "working" | "waiting-approval";
  readonly actionsStopped?: boolean;
  readonly elapsedSeconds: number;
  readonly voiceCostUsd: number;
  readonly limitSeconds: number;
  readonly transcript: ReadonlyArray<LiveTranscriptEntry>;
  readonly requests: ReadonlyArray<LiveRequestEntry>;
  readonly actions: ReadonlyArray<LiveActionEntry>;
  readonly message?: string;
}
export interface LiveStartResult {
  readonly sessionId: string;
  readonly connectionEpoch: number;
  readonly answerSdp: string;
  readonly snapshot: LiveSnapshot;
}
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
