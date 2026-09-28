import { Effect, Schema } from "effect";
import type { OffboardArgs } from "../../shared/work-control";
import { InputError } from "./errors";
import { decodeJsonText } from "./json";
import { readSource, sourceOf } from "./signal-input";

const OffboardPayload = Schema.Struct({
  notes: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/**
 * How `junto offboard <notes>` reads its notes: markdown inline, `@file`, `-`
 * for stdin, or the JSON object `{"notes": "..."}`.
 */
export const loadOffboardArgs = (input: string) =>
  Effect.gen(function* () {
    if (input.trim() === "") {
      return yield* Effect.fail(
        new InputError({
          message: "write your notes on this session",
          path: "input",
          hint: 'junto offboard "Shipped the parser; next is retry on 429s. Why it matters: ..."',
        }),
      );
    }
    const source = sourceOf(input);
    const body = yield* readSource(source);
    // Markdown never opens with this object, so the JSON form is unambiguous.
    const json = /^\{\s*"notes"\s*:/.test(body.trim());
    const payload = json ? yield* decodeJsonText(OffboardPayload, body, source.kind) : { notes: body };
    const args: OffboardArgs = { notes: payload.notes };
    return args;
  });
