/**
 * The payloads of the core pushes that no shared module owns: each Schema is
 * the one declaration of its payload, the type is derived from it, and main
 * decodes a push against it on receipt (channels.ts names which channel
 * carries which).
 */
import { Schema } from "effect";

/** What a lease's end says: which view, and why its machine ended it. */
export const TermLeaseEnded = Schema.Struct({ leaseId: Schema.String, reason: Schema.String });
export type TermLeaseEnded = typeof TermLeaseEnded.Type;

/** A resource changed under a canvas: which canvas, and which node. */
export const ResourceChanged = Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String });
export type ResourceChanged = typeof ResourceChanged.Type;

/** A backlink landed under a canvas; the panes read their mentions again. */
export const MentionChanged = Schema.Struct({ canvasName: Schema.String });
export type MentionChanged = typeof MentionChanged.Type;

/** A push that carries nothing: the channel's name is the whole message. */
export const NoPayload = Schema.Null;
export type NoPayload = typeof NoPayload.Type;

/** A push that carries an empty record: the window reads again what it holds. */
export const EmptyRecord = Schema.Record(Schema.String, Schema.Never);
export type EmptyRecord = typeof EmptyRecord.Type;
