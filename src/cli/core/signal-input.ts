import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import type { AgentSignalAttachmentInput, AgentSignalKind } from "../../shared/agent-signals";
import type { SignalRaiseArgs } from "../../shared/work-control";
import {
  type AttachFlags,
  liveAttachProbe,
  planAttachFlags,
  planAttachItems,
  SignalAttachCliItem,
  stageAttachPlans,
  stdinUses,
} from "./signal-attach";
import { InputError } from "./errors";
import { decodeJsonText } from "./json";

/**
 * How `junto escalate|blocked|feedback <input> [--detail <md>] [--attach
 * <file>]...` reads its input. The sentence can be plain text (the common
 * case), or the usual JSON object inline, `@file`, or `-` for stdin.
 * `--detail` is markdown given inline, `@file`, or `-` for stdin. Stdin feeds
 * at most one of them.
 *
 * What is attached (`--attach`, `--code`, `--diff`, `--compare`, `--commit`,
 * `--video`, or the JSON input's `attach` list) is read and uploaded by
 * `signal-attach.ts`; the signal names it by reference, so a path never
 * crosses the socket and a file of any kind and size can be attached.
 */
export type SignalSource =
  | { readonly kind: "stdin" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "inline"; readonly text: string };

/** `-` or `@-` is stdin, `@path` a file, anything else the text itself. */
export const sourceOf = (raw: string): SignalSource => {
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

const readStdin = Effect.tryPromise({
  try: () => new Response(Bun.stdin.stream()).text(),
  catch: (cause) =>
    new InputError({
      message: cause instanceof Error ? cause.message : "failed to read stdin",
      path: "stdin",
    }),
});

export const readSource = (source: SignalSource) => {
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

/**
 * What `junto escalate|blocked|feedback` takes as its JSON input: the one
 * schema the CLI decodes with. The command name is the kind, so there is
 * none here. `attach` is a list of items, each exactly one shape
 * (`SignalAttachCliItem`).
 */
export const SignalRaiseCliInput = Schema.Struct({
  text: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  attach: Schema.optionalKey(Schema.Array(SignalAttachCliItem)),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SignalRaiseCliInput = typeof SignalRaiseCliInput.Type;

/** `signal.raise` as this CLI sends it: the sentence, the detail, and what is attached, by reference. */
export type SignalRaiseRequest = Omit<SignalRaiseArgs, "attach"> & {
  readonly attach?: ReadonlyArray<AgentSignalAttachmentInput>;
};

const ATTACH_FLAG_NAMES = ["attach", "code", "diff", "compare", "commit", "video"] as const;

export const loadSignalRaiseArgs = (
  kind: AgentSignalKind,
  input: string,
  detail: string | undefined,
  /** The attachment flags; a bare list is `--attach` values. */
  attachFlags: AttachFlags | ReadonlyArray<string> = {},
  timeoutMs?: number,
) =>
  Effect.gen(function* () {
    const flags: AttachFlags = Array.isArray(attachFlags) ? { attach: attachFlags } : (attachFlags as AttachFlags);
    const planned = planSignalInvocation(input, detail);
    if (!planned.ok) return yield* Effect.fail(planned.error);
    const { plan } = planned;
    const given = ATTACH_FLAG_NAMES.filter((name) => (flags[name]?.length ?? 0) > 0);
    // Flags are checked before anything is read, so a bad one costs nothing.
    const fromFlags = planAttachFlags(flags, liveAttachProbe);
    if (!fromFlags.ok) return yield* Effect.fail(fromFlags.error);
    const body = yield* readSource(plan.input);
    const payload = plan.input.json
      ? yield* decodeJsonText(SignalRaiseCliInput, body, plan.input.kind)
      : { text: body };
    if (given.length > 0 && payload.attach !== undefined) {
      return yield* Effect.fail(
        new InputError({
          message: `attachments given twice: in the JSON input and in --${given[0]}`,
          path: `--${given[0]}`,
          hint: "use the flags or the JSON attach list, not both",
        }),
      );
    }
    const plans = payload.attach !== undefined ? planAttachItems(payload.attach) : fromFlags.plans;
    // Stdin feeds one thing only: the sentence, the detail, or one attached text.
    const piped = stdinUses(plans);
    if (piped + (plan.input.kind === "stdin" ? 1 : 0) + (plan.detail?.kind === "stdin" ? 1 : 0) > 1) {
      return yield* Effect.fail(
        new InputError({
          message: "stdin can feed one thing: the sentence, --detail, or one attached text",
          path: "stdin",
          hint: 'pipe one and write the others inline or from a file: git diff | junto feedback "..." --diff -',
        }),
      );
    }
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
    const stdin = piped > 0 ? yield* readStdin : undefined;
    const attach =
      plans.length > 0
        ? yield* stageAttachPlans(plans, {
            ...(stdin === undefined ? {} : { stdin }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          })
        : [];
    const args: SignalRaiseRequest = {
      kind,
      text: payload.text,
      ...(resolvedDetail === undefined ? {} : { detail: resolvedDetail }),
      ...(attach.length > 0 ? { attach } : {}),
    };
    return args;
  });
