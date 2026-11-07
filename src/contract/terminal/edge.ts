/**
 * Where a one-way message enters a program off the terminal link. A control
 * message (a resize, a gate, an exit) is decoded closed, so a drifted field
 * or an extra one is refused here and never reaches a PTY or a seat. A hot
 * message (`write`, `ack`, `data`, `typing`, `input`) passes by its tag,
 * typed and untouched: no decode, no copy, no fiber, once per keystroke or
 * PTY read.
 *
 * An edge never throws. A refused message comes back as `LinkFrameRefused`
 * for the caller to log; the handler is not called.
 */
import { Result, Schema } from "effect";
import {
  Command,
  type CommandHandlers,
  Event,
  type EventHandlers,
  type HandlersOf,
  ParentCommand,
  type ParentCommandHandlers,
  PORT_TAGS,
  RAW_COMMAND_TAGS,
  RAW_EVENT_TAGS,
} from "./messages";

/** A message the edge would not hand to a handler: not tagged, an unknown tag, a bad field, or a missing port. */
export class LinkFrameRefused extends Schema.TaggedError<LinkFrameRefused>()("LinkFrameRefused", {
  /** The message's tag, or empty when it had none. */
  tag: Schema.String,
  message: Schema.String,
}) {}

const closed = { onExcessProperty: "error" } as const;

const portTags: ReadonlySet<string> = new Set(PORT_TAGS);

type Tagged = { readonly _tag: string };

const tagOf = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const tag = (message as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

const edge = <U extends Tagged, P>(
  schema: Schema.Codec<U, unknown>,
  raw: ReadonlyArray<string>,
  handlers: HandlersOf<U, P>,
): ((message: unknown, port?: P) => Result.Result<void, LinkFrameRefused>) => {
  const decode = Schema.decodeUnknownResult(schema, closed);
  const hot: ReadonlySet<string> = new Set(raw);
  const handlerOf = handlers as unknown as Readonly<Record<string, (message: U, port?: P) => void>>;
  return (message, port) => {
    const tag = tagOf(message);
    if (tag === undefined) return Result.fail(new LinkFrameRefused({ tag: "", message: "not a tagged message" }));
    // An own key only: a tag such as "constructor" names no handler.
    if (!Object.hasOwn(handlerOf, tag)) return Result.fail(new LinkFrameRefused({ tag, message: `no message of this link is tagged ${tag}` }));
    let typed: U;
    if (hot.has(tag)) {
      typed = message as U;
    } else {
      const decoded = decode(message);
      if (Result.isFailure(decoded)) return Result.fail(new LinkFrameRefused({ tag, message: decoded.failure.message }));
      typed = decoded.success;
    }
    if (portTags.has(tag)) {
      if (port === undefined) return Result.fail(new LinkFrameRefused({ tag, message: "arrived without the port it carries" }));
      handlerOf[tag]!(typed, port);
    } else {
      handlerOf[tag]!(typed);
    }
    return Result.void;
  };
};

/** The terminal process's edge for its core's commands. `port` is the one moved beside a `surfaceOpen`. */
export const commandEdge = <P>(handlers: CommandHandlers<P>) => edge<Command, P>(Command, RAW_COMMAND_TAGS, handlers);

/** The terminal process's edge for main's commands, all decoded. `port` is the one moved beside a `connect`. */
export const parentEdge = <P>(handlers: ParentCommandHandlers<P>) => edge<ParentCommand, P>(ParentCommand, [], handlers);

/** The core's edge for its terminal process's events. No event carries a port. */
export const eventEdge = (handlers: EventHandlers): ((message: unknown) => Result.Result<void, LinkFrameRefused>) => {
  const run = edge<Event, never>(Event, RAW_EVENT_TAGS, handlers);
  return (message) => run(message);
};
