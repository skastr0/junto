/**
 * A link channel's contract: its name, one `effect/rpc` RpcGroup with an Rpc
 * per request tag (payload, success, error), and its event schema when it
 * carries events. Both ends of a link are one build (the hello refuses any
 * other, `session.ts`), so the compiler proves the contract once for both:
 * the typed client (`linkClient`) and the handlers (`bindLinkChannel`) are
 * typed by the same value, and a change to any of its schemas fails the
 * compile of every caller and every handler.
 *
 * The session dispatches by the contract, not by RPC's protocol: the link is
 * peer to peer, carries events and a credit window, and takes identity from
 * the admitted hello (docs/machines.md). It decodes every payload at receipt
 * with the tag's own schema and encodes every value it sends with it, so the
 * types the compiler checked are the ones that cross.
 */
import { Effect, Schema } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import { MachineLink, type LinkRequestOptions } from "./service";
import type { LinkChannel, LinkChannelContext, LinkEventContext, MachineLinkError } from "./types";

/** One schema as JSON crosses the link: each throws on a value outside it, excess keys included. */
export interface LinkWireCodec {
  readonly encode: (value: unknown) => unknown;
  readonly decode: (json: unknown) => unknown;
  readonly is: (value: unknown) => boolean;
}

/** One request tag's codecs, as the session reads them. */
export interface LinkRpcWire {
  readonly payload: LinkWireCodec;
  readonly success: LinkWireCodec;
  readonly error: LinkWireCodec;
}

export interface LinkContract<Name extends LinkChannel, R extends Rpc.Any, Event extends Schema.Top> {
  readonly channel: Name;
  readonly group: RpcGroup.RpcGroup<R>;
  /** `Schema.Never` on a channel that carries no events, so its typed send takes nothing. */
  readonly event: Event;
  /** Each request tag's codecs, built once. */
  readonly requests: ReadonlyMap<string, LinkRpcWire>;
  /** Absent on a channel that carries no events. */
  readonly events: LinkWireCodec | undefined;
}

// RpcGroup is invariant in its Rpcs, so only `any` stands for every contract,
// and an empty group (events only, or a channel not yet served) is `never`'s.
// oxlint-disable-next-line no-explicit-any
export type AnyLinkContract = LinkContract<LinkChannel, any, Schema.Top> | LinkContract<LinkChannel, never, Schema.Top>;
// Every parameter is inferred: RpcGroup's invariance would refuse a fixed one.
export type LinkRpcsOf<C> = C extends LinkContract<infer _Name, infer R, infer _Event> ? R : never;
export type LinkEventOf<C> = C extends LinkContract<infer _Name, infer _R, infer E> ? E["Type"] : never;

const strict = { onExcessProperty: "error" } as const;

/**
 * The JSON codec the core's RPC uses on its port too (`shared/rpc-port.ts`),
 * strict. A link schema needs no services: one that did would refuse its
 * first value, never pass it.
 */
const wireCodec = (schema: Schema.Top): LinkWireCodec => {
  const json = Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>);
  return { encode: Schema.encodeUnknownSync(json, strict), decode: Schema.decodeUnknownSync(json, strict), is: Schema.is(schema) };
};

/** Every Rpc of a group with its schemas; RpcGroup's map erases them to `Rpc.Any`. */
const rpcsWithProps = (group: RpcGroup.RpcGroup<Rpc.Any>): ReadonlyArray<Rpc.AnyWithProps> =>
  [...group.requests.values()].map((rpc) => rpc as Rpc.AnyWithProps);

export function linkContract<const Name extends LinkChannel, R extends Rpc.Any>(channel: Name, group: RpcGroup.RpcGroup<R>): LinkContract<Name, R, typeof Schema.Never>;
export function linkContract<const Name extends LinkChannel, R extends Rpc.Any, Event extends Schema.Top>(channel: Name, group: RpcGroup.RpcGroup<R>, options: { readonly event: Event }): LinkContract<Name, R, Event>;
export function linkContract(channel: LinkChannel, group: RpcGroup.RpcGroup<Rpc.Any>, options?: { readonly event: Schema.Top }): AnyLinkContract {
  const requests = new Map<string, LinkRpcWire>();
  for (const rpc of rpcsWithProps(group)) {
    requests.set(rpc._tag, { payload: wireCodec(rpc.payloadSchema), success: wireCodec(rpc.successSchema), error: wireCodec(rpc.errorSchema) });
  }
  return { channel, group, event: options?.event ?? Schema.Never, requests, events: options === undefined ? undefined : wireCodec(options.event) };
}

type Tagged<R extends Rpc.Any, Tag extends string> = Rpc.ExtractTag<R, Tag>;

/** One request tag's handler, typed by its Rpc. Identity is the admitted hello's, in `context`. */
export type LinkRequestHandler<R extends Rpc.Any> = (payload: Rpc.Payload<R>, context: LinkChannelContext) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>>;

type EventHandlers<Event> = [Event] extends [never]
  ? { readonly event?: never }
  : { readonly event: (payload: Event, context: LinkEventContext) => Effect.Effect<void, unknown> };

/** Every request tag's handler, and the event handler when the channel carries events. */
export type LinkHandlers<C extends AnyLinkContract> = {
  readonly requests: { readonly [Tag in LinkRpcsOf<C>["_tag"]]: LinkRequestHandler<Tagged<LinkRpcsOf<C>, Tag>> };
  /** Runs in the channel's event queue, so it gets no request. */
  readonly opened?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
  readonly closed?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
} & EventHandlers<LinkEventOf<C>>;

/**
 * A contract channel as the session holds it, beside the channels not yet
 * converted (`LinkChannelHandler`). The handlers were typed by the contract
 * when bound; the session hands each one only a payload its tag decoded.
 */
export interface LinkContractChannel {
  readonly _tag: "LinkContractChannel";
  readonly contract: AnyLinkContract;
  readonly handleRequest: (tag: string, context: LinkChannelContext, payload: unknown) => Effect.Effect<unknown, unknown>;
  readonly handleEvent?: (context: LinkEventContext, payload: unknown) => Effect.Effect<void, unknown>;
  readonly opened?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
  readonly closed?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
}

export const isLinkContractChannel = (channel: object): channel is LinkContractChannel =>
  (channel as { readonly _tag?: unknown })._tag === "LinkContractChannel";

/** Binds a contract's handlers for the session. */
export const bindLinkChannel = <C extends AnyLinkContract>(contract: C, handlers: LinkHandlers<C>): LinkContractChannel => {
  // The session decoded `payload` with this tag's own schema before it calls here.
  const requests = handlers.requests as Record<string, (payload: unknown, context: LinkChannelContext) => Effect.Effect<unknown, unknown>>;
  const event = (handlers as { readonly event?: (payload: unknown, context: LinkEventContext) => Effect.Effect<void, unknown> }).event;
  return {
    _tag: "LinkContractChannel",
    contract,
    handleRequest: (tag, context, payload) => requests[tag]!(payload, context),
    ...(event === undefined ? {} : { handleEvent: (context: LinkEventContext, payload: unknown) => event(payload, context) }),
    ...(handlers.opened === undefined ? {} : { opened: handlers.opened }),
    ...(handlers.closed === undefined ? {} : { closed: handlers.closed }),
  };
};

/** One request tag as its caller sees it: the peer's typed refusal, or the link's. */
export type LinkClientCall<R extends Rpc.Any> = (machine: string, payload: Rpc.Payload<R>, options?: LinkRequestOptions) =>
  Effect.Effect<Rpc.Success<R>, Rpc.Error<R> | MachineLinkError>;

export type LinkClient<C extends AnyLinkContract> = {
  readonly [Tag in LinkRpcsOf<C>["_tag"]]: LinkClientCall<Tagged<LinkRpcsOf<C>, Tag>>;
} & {
  readonly sendEvent: (machine: string, payload: LinkEventOf<C>) => Effect.Effect<void, MachineLinkError>;
};

/**
 * The typed client of one channel, over this core's link. The session
 * encodes the payload with the tag's schema and decodes the answer and the
 * peer's refusal with it, so the casts below only name what it decoded.
 */
export const linkClient = <C extends AnyLinkContract>(contract: C): Effect.Effect<LinkClient<C>, never, MachineLink> =>
  Effect.map(MachineLink, (link) => {
    const calls: Record<string, (machine: string, payload: unknown, options?: LinkRequestOptions) => Effect.Effect<unknown, unknown>> = {};
    for (const tag of contract.requests.keys()) {
      // A refusal the tag's error schema decoded crosses as `detail`; the caller gets it as itself.
      calls[tag] = (machine, payload, options) =>
        link.request(machine, contract.channel, payload, { ...options, tag }).pipe(
          Effect.catchTag("LinkRequestFailed", (failed) => Effect.fail(failed.detail === undefined ? failed : failed.detail)),
        );
    }
    return { ...calls, sendEvent: (machine: string, payload: unknown) => link.sendEvent(machine, contract.channel, payload) } as unknown as LinkClient<C>;
  });
