import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import type { AgentSignalKind } from "../../shared/agent-signals";
import type { SignalRaiseArgs } from "../../shared/work-control";
import { InputError } from "./errors";
import { decodeJsonText } from "./json";

/**
 * How `junto escalate|blocked|feedback <input> [--detail <md>]` reads its
 * input. The sentence can be plain text (the common case), or the usual JSON
 * object inline, `@file`, or `-` for stdin. `--detail` is markdown given
 * inline, `@file`, or `-` for stdin. Stdin feeds at most one of them.
 */
export type SignalSource =
  | { readonly kind: "stdin" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "inline"; readonly text: string };

const sourceOf = (raw: string): SignalSource => {
  const trimmed = raw.trim();
  if (trimmed === "-" || trimmed === "@-") return { kind: "stdin" };
  if (trimmed.startsWith("@") && trimmed.length > 1) {
    return { kind: "file", path: trimmed.slice(1) };
  }
  return { kind: "inline", text: raw };
};

export type SignalInvocationPlan = {
  /** The positional input: JSON when it is a source or an object literal. */
  readonly input: SignalSource & { readonly json: boolean };
  readonly detail?: SignalSource;
};

/** Pure: decide where each part comes from and refuse ambiguous mixes. */
export const planSignalInvocation = (
  input: string,
  detail: string | undefined,
): { readonly ok: true; readonly plan: SignalInvocationPlan } | {
  readonly ok: false;
  readonly error: InputError;
} => {
  if (input.trim() === "") {
    return {
      ok: false,
      error: new InputError({
        message: "say what you need in one sentence",
        path: "input",
        hint: 'junto blocked "Need the staging API key to run the deploy check."',
      }),
    };
  }
  const source = sourceOf(input);
  const json = source.kind !== "inline" || source.text.trim().startsWith("{");
  const detailSource = detail === undefined ? undefined : sourceOf(detail);
  if (source.kind === "stdin" && detailSource?.kind === "stdin") {
    return {
      ok: false,
      error: new InputError({
        message: "stdin can feed the input or --detail, not both",
        path: "--detail",
        hint: "pass the sentence inline and pipe the detail: ... | junto blocked \"...\" --detail -",
      }),
    };
  }
  return {
    ok: true,
    plan: {
      input: { ...source, json },
      ...(detailSource === undefined ? {} : { detail: detailSource }),
    },
  };
};

const SignalPayload = Schema.Struct({
  text: Schema.String,
  detail: Schema.optionalKey(Schema.String),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const readStdin = Effect.tryPromise({
  try: () => new Response(Bun.stdin.stream()).text(),
  catch: (cause) =>
    new InputError({
      message: cause instanceof Error ? cause.message : "failed to read stdin",
      path: "stdin",
    }),
});

const readSource = (source: SignalSource) => {
  switch (source.kind) {
    case "stdin":
      return readStdin;
    case "file":
      return Effect.tryPromise({
        try: () => readFile(source.path, "utf8"),
        catch: (cause) =>
          new InputError({
            message: cause instanceof Error ? cause.message : "read failed",
            path: source.path,
          }),
      });
    case "inline":
      return Effect.succeed(source.text);
  }
};

export const loadSignalRaiseArgs = (
  kind: AgentSignalKind,
  input: string,
  detail: string | undefined,
) =>
  Effect.gen(function* () {
    const planned = planSignalInvocation(input, detail);
    if (!planned.ok) return yield* Effect.fail(planned.error);
    const { plan } = planned;
    const body = yield* readSource(plan.input);
    const payload = plan.input.json
      ? yield* decodeJsonText(SignalPayload, body, plan.input.kind)
      : { text: body };
    const detailText = plan.detail ? yield* readSource(plan.detail) : undefined;
    if (detailText !== undefined && payload.detail !== undefined) {
      return yield* Effect.fail(
        new InputError({
          message: "detail given twice: in the JSON input and in --detail",
          path: "--detail",
        }),
      );
    }
    const resolvedDetail = detailText ?? payload.detail;
    const args: SignalRaiseArgs = {
      kind,
      text: payload.text,
      ...(resolvedDetail === undefined ? {} : { detail: resolvedDetail }),
    };
    return args;
  });
