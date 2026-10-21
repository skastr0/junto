import { Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import { mintOpId } from "../../shared/resource-command";
import { OpId } from "../../shared/work-ids";
import { InputError, WireError } from "./errors";

/**
 * The opId of a resource write (plan 02, rule 4). This process mints it, never
 * main, so a write that timed out can be sent again under the same opId and
 * applies once. Every write command takes `--op-id` for that retry.
 */
export const opIdFlag = Flag.string("op-id").pipe(
  Flag.optional,
  Flag.withDescription("Resend a write that timed out with the opId it returned, so it applies once"),
);

/** The opId `--op-id` names, or a new one. */
export const opIdOf = (given: Option.Option<string>): Effect.Effect<OpId, InputError> =>
  Option.match(given, {
    onNone: () => Effect.succeed(mintOpId()),
    onSome: (text) =>
      Schema.decodeUnknownEffect(OpId)(text.trim()).pipe(
        Effect.mapError(() => new InputError({ message: "--op-id must be the ULID a write returned", path: "--op-id", received: text })),
      ),
  });

/** The opId a write carries in its args, when it is a resource write. */
export const opIdInArgs = (args: unknown): OpId | undefined => {
  if (typeof args !== "object" || args === null || !("opId" in args)) return undefined;
  const opId = (args as { readonly opId: unknown }).opId;
  return Schema.is(OpId)(opId) ? opId : undefined;
};

/**
 * A resource write that was sent and got no answer: it may have applied. The
 * opId comes back so the same write can be sent again; it applies once.
 */
export const writeTimeout = (opId: OpId, message: string): WireError =>
  new WireError({
    type: "Timeout",
    message: `${message}; the write may have applied`,
    details: {
      opId,
      retryable: true,
      next_step: `send the same command again with --op-id ${opId}; it applies once, or read it with junto op show ${opId}`,
    },
  });
