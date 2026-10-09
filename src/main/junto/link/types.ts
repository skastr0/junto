import type { Effect } from "effect";
import type { InstallationId } from "@shared/installation-id";

export type LinkChannel = "rows" | "seats" | "status";

export interface LinkHello {
  readonly build: string;
  readonly installationId: InstallationId;
  readonly machineName: string;
}

export class MachineLinkError extends Error {
  readonly _tag = "MachineLinkError";
}

/** Identity comes only from an admitted hello, never from a channel payload. */
export interface LinkChannelContext {
  readonly peer: LinkHello;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly sendEvent: (channel: LinkChannel, payload: unknown) => Effect.Effect<void, MachineLinkError>;
  readonly request: (channel: LinkChannel, payload: unknown) => Effect.Effect<unknown, MachineLinkError>;
}

/**
 * Each decoder must reject excess fields and throw on invalid input. The
 * session calls it before dispatch, pending-response resolution or event use.
 * A channel without requests or events supplies a decoder that rejects them.
 */
export interface LinkChannelHandler {
  readonly decodeRequest: (payload: unknown) => unknown;
  readonly decodeResponse: (payload: unknown) => unknown;
  readonly decodeEvent: (payload: unknown) => unknown;
  readonly handleRequest?: (context: LinkChannelContext, payload: unknown) => Effect.Effect<unknown, unknown>;
  readonly handleEvent?: (context: LinkChannelContext, payload: unknown) => Effect.Effect<void, unknown>;
  readonly opened?: (context: LinkChannelContext) => Effect.Effect<void, unknown>;
  readonly closed?: (context: LinkChannelContext) => Effect.Effect<void, unknown>;
}

export type LinkChannels = Readonly<Partial<Record<LinkChannel, LinkChannelHandler>>>;

/** The identical session interface over a socket or an SSH duplex stream. */
export interface LinkSession {
  readonly sessionId: string;
  readonly ready: Promise<LinkHello>;
  readonly closed: Promise<void>;
  readonly request: (channel: LinkChannel, payload: unknown) => Promise<unknown>;
  readonly sendEvent: (channel: LinkChannel, payload: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
}
