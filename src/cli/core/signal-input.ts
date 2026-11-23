import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import {
  AGENT_SIGNAL_MAX_DEPENDS_ON,
  AGENT_SIGNAL_MAX_SUGGESTIONS,
  AgentSignalSuggestions,
  SeatRaiseKind,
  type AgentSignalKind,
  SignalFormRequest,
} from "../../shared/agent-signals";
import { SIGNAL_BATCH_MAX, type SignalBatchArgs, type SignalBatchItem, type SignalRaiseArgs } from "../../shared/work-control";
import { isUlid } from "../../shared/ulid";
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
import { type FormFlags, foldFormInput, planFormFlags } from "./signal-form";
import { decodeJsonText } from "./json";

/**
 * How `junto escalate|blocked|feedback <input> [--detail <md>] [--attach
 * <file>]...` reads its input. The sentence can be plain text (the common
 * case), or the usual JSON object inline, `@file`, or `-` for stdin.
 * `--detail` is markdown given inline, `@file`, or `-` for stdin. Stdin feeds
 * at most one of them.
 *
 * What is attached (`--attach`, `--code`, `--diff`, `--compare`, `--commit`,
 * `--video`, `--task`, `--artifact`, or the JSON input's `attach` list) is read and uploaded by
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
  /**
   * Up to two replies pre-baked for the operator, each a line they can send
   * as-is (`AgentSignalSuggestions`). They sit ahead of the quick replies on
   * the card.
   */
  suggest: Schema.optionalKey(AgentSignalSuggestions),
  /** The reply form the operator answers in (N1's `SignalFormRequest`); blocked and escalate only. */
  form: Schema.optionalKey(SignalFormRequest),
});
export type SignalRaiseCliInput = typeof SignalRaiseCliInput.Type;

const ATTACH_FLAG_NAMES = ["attach", "code", "diff", "compare", "commit", "video", "task", "artifact"] as const;

export const loadSignalRaiseArgs = (
  kind: SeatRaiseKind,
  input: string,
  detail: string | undefined,
  /** The attachment flags; a bare list is `--attach` values. */
  attachFlags: AttachFlags | ReadonlyArray<string> = {},
  timeoutMs?: number,
  /** `--suggest` values: replies the operator can send in one click. */
  suggestFlags: ReadonlyArray<string> = [],
  /** `--ask-secret`, `--ask-artifact` with `--min-words` and `--label`, `--ask-proof`. */
  formFlags: FormFlags = {},
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
    const formFromFlags = planFormFlags(kind, formFlags);
    if (!formFromFlags.ok) return yield* Effect.fail(formFromFlags.error);
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
    if (suggestFlags.length > 0 && payload.suggest !== undefined) {
      return yield* Effect.fail(
        new InputError({
          message: "suggested replies given twice: in the JSON input and in --suggest",
          path: "--suggest",
          hint: "use the flags or the JSON suggest list, not both",
        }),
      );
    }
    if (formFromFlags.form !== undefined && payload.form !== undefined) {
      return yield* Effect.fail(
        new InputError({
          message: "a form given twice: in the JSON input and in the --ask flags",
          path: "form",
          hint: "use the flags or the JSON form, not both",
        }),
      );
    }
    const formFromInput = payload.form === undefined ? undefined : foldFormInput(kind, payload.form);
    if (formFromInput !== undefined && !formFromInput.ok) return yield* Effect.fail(formFromInput.error);
    const form = formFromFlags.form ?? formFromInput?.form;
    const suggested = suggestFlags.length > 0 ? [...suggestFlags] : [...(payload.suggest ?? [])];
    if (suggested.length > AGENT_SIGNAL_MAX_SUGGESTIONS) {
      return yield* Effect.fail(
        new InputError({
          message: `at most ${AGENT_SIGNAL_MAX_SUGGESTIONS} suggested replies`,
          path: "--suggest",
          hint: "pre-bake the two the operator is most likely to send",
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
    const args: SignalRaiseArgs = {
      kind,
      text: payload.text,
      ...(resolvedDetail === undefined ? {} : { detail: resolvedDetail }),
      ...(attach.length > 0 ? { attach } : {}),
      ...(suggested.length > 0 ? { suggest: suggested } : {}),
      ...(form === undefined ? {} : { form }),
    };
    return args;
  });

/** Where a raise stands: `--thread`, `--depends-on` and `--depends-on-last`. */
export type OrderFlags = {
  readonly thread?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly dependsOnLast?: boolean;
};

const notUlid = (path: string, what: string) =>
  new InputError({ message: `${path} takes ${what}: a ULID, 26 characters of Crockford base32`, path, hint: "junto thread list and junto signal list print the ids" });

/** The flags as the raise carries them, each id checked before anything is read or sent. */
export const planOrderFlags = (flags: OrderFlags): Effect.Effect<Pick<SignalRaiseArgs, "thread" | "dependsOn" | "dependsOnLast">, InputError> =>
  Effect.gen(function* () {
    const thread = flags.thread?.trim();
    if (thread !== undefined && !isUlid(thread)) return yield* Effect.fail(notUlid("--thread", "a thread id or the id of any mail in it"));
    const dependsOn = (flags.dependsOn ?? []).map((id) => id.trim());
    const bad = dependsOn.find((id) => !isUlid(id));
    if (bad !== undefined) return yield* Effect.fail(notUlid("--depends-on", "a signal id"));
    if (dependsOn.length > AGENT_SIGNAL_MAX_DEPENDS_ON) {
      return yield* Effect.fail(new InputError({ message: `a signal comes after at most ${AGENT_SIGNAL_MAX_DEPENDS_ON} others`, path: "--depends-on" }));
    }
    return {
      ...(thread === undefined ? {} : { thread }),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(flags.dependsOnLast === true ? { dependsOnLast: true } : {}),
    };
  });

/**
 * One item of `junto signal batch`: a raise's JSON input with its kind, the
 * thread it is raised in, and what it comes after: earlier items by position
 * from 1, or this seat's own signals by id. Absent, it comes after the item
 * before it; an empty list, after nothing.
 */
export const SignalBatchCliItem = Schema.Struct({
  kind: SeatRaiseKind,
  ...SignalRaiseCliInput.fields,
  thread: Schema.optionalKey(Schema.String),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.Union([Schema.Int, Schema.String]))),
});
export type SignalBatchCliItem = typeof SignalBatchCliItem.Type;

/** What `junto signal batch` reads: a JSON list of items, or `{"signals": [...]}`. */
const SignalBatchCliInput = Schema.Union([
  Schema.Array(SignalBatchCliItem),
  Schema.Struct({ signals: Schema.Array(SignalBatchCliItem) }),
]);

/**
 * `junto signal batch <input>`: the list inline, `@file`, or `-` for stdin,
 * raised in the order given. Every item is checked before anything goes up;
 * stdin feeds the list only, so an attached text comes from a file or inline.
 */
export const loadSignalBatchArgs = (input: string, timeoutMs?: number) =>
  Effect.gen(function* () {
    if (input.trim() === "") {
      return yield* Effect.fail(new InputError({
        message: "give the signals as a JSON list",
        path: "input",
        hint: 'junto signal batch \'[{"kind":"escalate","text":"First topic."},{"kind":"escalate","text":"Second topic."}]\'',
      }));
    }
    const source = sourceOf(input);
    const decoded = yield* decodeJsonText(SignalBatchCliInput, yield* readSource(source), source.kind);
    const items = Array.isArray(decoded) ? decoded : (decoded as { readonly signals: ReadonlyArray<SignalBatchCliItem> }).signals;
    if (items.length === 0 || items.length > SIGNAL_BATCH_MAX) {
      return yield* Effect.fail(new InputError({ message: `a batch raises 1 to ${SIGNAL_BATCH_MAX} signals`, path: "input" }));
    }
    const planned = [];
    for (const [index, item] of items.entries()) {
      const path = `signals[${index}]`;
      if ((item.suggest?.length ?? 0) > AGENT_SIGNAL_MAX_SUGGESTIONS) {
        return yield* Effect.fail(new InputError({ message: `at most ${AGENT_SIGNAL_MAX_SUGGESTIONS} suggested replies`, path: `${path}.suggest` }));
      }
      const form = item.form === undefined ? undefined : foldFormInput(item.kind, item.form);
      if (form !== undefined && !form.ok) return yield* Effect.fail(new InputError({ message: form.error.message, path: `${path}.${form.error.path ?? "form"}` }));
      const thread = item.thread?.trim();
      if (thread !== undefined && !isUlid(thread)) return yield* Effect.fail(notUlid(`${path}.thread`, "a thread id or the id of any mail in it"));
      const dependsOn = item.dependsOn?.map((ref: number | string) => (typeof ref === "string" ? ref.trim() : ref));
      for (const [at, ref] of (dependsOn ?? []).entries()) {
        const where = `${path}.dependsOn[${at}]`;
        if (typeof ref === "string" ? !isUlid(ref) : ref < 1 || ref > index) {
          return yield* Effect.fail(new InputError({
            message: typeof ref === "string"
              ? `${where} is not a signal id: a ULID, as junto signal list prints it`
              : `item ${index + 1} can come only after an earlier item, counted from 1`,
            path: where,
          }));
        }
      }
      if ((dependsOn?.length ?? 0) > AGENT_SIGNAL_MAX_DEPENDS_ON) {
        return yield* Effect.fail(new InputError({ message: `a signal comes after at most ${AGENT_SIGNAL_MAX_DEPENDS_ON} others`, path: `${path}.dependsOn` }));
      }
      const plans = item.attach === undefined ? [] : planAttachItems(item.attach);
      if (stdinUses(plans) > 0) {
        return yield* Effect.fail(new InputError({ message: "stdin feeds the batch only: attach a text from a file or inline", path: `${path}.attach` }));
      }
      planned.push({ item, form: form?.form, thread, dependsOn, plans });
    }
    const signals: Array<SignalBatchItem> = [];
    for (const { item, form, thread, dependsOn, plans } of planned) {
      const attach = plans.length > 0 ? yield* stageAttachPlans(plans, timeoutMs === undefined ? {} : { timeoutMs }) : [];
      signals.push({
        kind: item.kind,
        text: item.text,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(attach.length > 0 ? { attach } : {}),
        ...(form === undefined ? {} : { form }),
        ...(item.suggest !== undefined && item.suggest.length > 0 ? { suggest: item.suggest } : {}),
        ...(thread === undefined ? {} : { thread }),
        ...(dependsOn === undefined ? {} : { dependsOn }),
      });
    }
    const args: SignalBatchArgs = { signals };
    return args;
  });
