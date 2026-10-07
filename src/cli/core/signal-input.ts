import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { Effect, Schema } from "effect";
import type { AgentSignalKind } from "../../shared/agent-signals";
import { ATTACHMENT_HEAD_BYTES, attachmentName, classifyAttachment } from "../../shared/preview-bytes";
import {
  type SignalAttachCliInput,
  SignalRaiseCliArgs,
  type SignalAttachmentInput,
  type SignalRaiseArgs,
} from "../../shared/work-control";
import { stageFile } from "./content-stage";
import { InputError } from "./errors";
import { decodeJsonText } from "./json";

/**
 * How `junto escalate|blocked|feedback <input> [--detail <md>] [--attach
 * <file>]...` reads its input. The sentence can be plain text (the common
 * case), or the usual JSON object inline, `@file`, or `-` for stdin.
 * `--detail` is markdown given inline, `@file`, or `-` for stdin. Stdin feeds
 * at most one of them.
 *
 * `--attach` names a file to show the operator, once per file:
 * `--attach /abs/shot.png` or `--attach "Before=/abs/shot.png"`. The JSON
 * input takes the same list as `attach: [{path, caption?}]`. The CLI
 * uploads each file in pieces (`stageFile`) and the signal names it by the
 * reference that comes back: a path never crosses the socket, and a file of
 * any size can be attached. The checks below only fail fast; main is the
 * authority on what is admitted.
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

/**
 * Pure: one `--attach` value as a file and its caption. A value that is a
 * file as written is that file; otherwise the text before the first `=` is
 * the caption, so a path with `=` in it is never misread.
 */
export const parseAttachFlag = (
  value: string,
  isFile: (path: string) => boolean,
): SignalAttachCliInput => {
  const at = value.indexOf("=");
  if (at <= 0 || isFile(value)) return { path: value };
  const caption = value.slice(0, at).trim();
  const path = value.slice(at + 1).trim();
  return caption ? { path, caption } : { path };
};

const attachError = (path: string, message: string) =>
  new InputError({
    message: `${path}: ${message}`,
    path: "--attach",
    hint: 'attach an image or a text file: --attach "Before=/abs/before.png"',
  });

const readHead = async (path: string, limit: number): Promise<Buffer> => {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(limit);
    let filled = 0;
    // A read may come back short before the end of the file.
    while (filled < limit) {
      const { bytesRead } = await handle.read(head, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return head.subarray(0, filled);
  } finally {
    await handle.close();
  }
};

/**
 * Judge every file from its start, refusing early what main would refuse
 * anyway, then upload each one. Nothing is uploaded unless all of them pass.
 * No count and no size of ours: a file is streamed from disk in pieces.
 */
const stageAttachments = (attach: ReadonlyArray<SignalAttachCliInput>, timeoutMs?: number) =>
  Effect.gen(function* () {
    const judged = yield* Effect.forEach(attach, (item) =>
      Effect.gen(function* () {
        const name = attachmentName(item.path) || "file";
        const kind = yield* Effect.tryPromise({
          try: async () => {
            // stat follows a link: what matters is that a regular file is read.
            const info = await stat(item.path);
            if (!info.isFile()) throw new Error("not a regular file");
            const head = await readHead(item.path, Math.min(info.size, ATTACHMENT_HEAD_BYTES));
            return classifyAttachment(name, head, info.size);
          },
          catch: (cause) => attachError(item.path, cause instanceof Error ? cause.message : "read failed"),
        });
        if (!kind.ok) return yield* Effect.fail(attachError(item.path, kind.reason));
        return { item, name, mediaType: kind.mediaType };
      }),
    );
    return yield* Effect.forEach(judged, ({ item, name, mediaType }) =>
      stageFile(item.path, {
        mediaType,
        displayName: name,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }).pipe(
        Effect.map(
          (ref): SignalAttachmentInput => ({
            ref: { sha256: ref.sha256, byteLength: ref.byteLength },
            ...(item.caption === undefined ? {} : { caption: item.caption }),
          }),
        ),
      ),
    );
  });

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

export const loadSignalRaiseArgs = (
  kind: AgentSignalKind,
  input: string,
  detail: string | undefined,
  attachFlags: ReadonlyArray<string> = [],
  timeoutMs?: number,
) =>
  Effect.gen(function* () {
    const planned = planSignalInvocation(input, detail);
    if (!planned.ok) return yield* Effect.fail(planned.error);
    const { plan } = planned;
    const body = yield* readSource(plan.input);
    const payload = plan.input.json
      ? yield* decodeJsonText(SignalRaiseCliArgs, body, plan.input.kind)
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
    if (attachFlags.length > 0 && payload.attach !== undefined) {
      return yield* Effect.fail(
        new InputError({
          message: "attachments given twice: in the JSON input and in --attach",
          path: "--attach",
        }),
      );
    }
    const attach =
      payload.attach ?? attachFlags.map((value) => parseAttachFlag(value, existsSync));
    const files = attach.length > 0 ? yield* stageAttachments(attach, timeoutMs) : [];
    const args: SignalRaiseArgs = {
      kind,
      text: payload.text,
      ...(resolvedDetail === undefined ? {} : { detail: resolvedDetail }),
      ...(files.length > 0 ? { attach: files } : {}),
    };
    return args;
  });
