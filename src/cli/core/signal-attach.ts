import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { admitLinkUrl, type AgentSignalAttachmentInput } from "../../shared/agent-signals";
import { ATTACHMENT_HEAD_BYTES, attachmentMediaType, attachmentName, isTextHead } from "../../shared/preview-bytes";
import { stageFile } from "./content-stage";
import { InputError } from "./errors";

/**
 * What an agent attaches to a needs-you signal, as it writes it: one flag
 * per kind, each repeatable, or the same things as objects in the JSON
 * input's `attach` list.
 *
 *   --attach  [Caption=]<path>                      any file
 *   --code    [Caption=]<language>:<text|@file|->   a code block
 *   --diff    [Caption=]<unified diff|@file|->      a diff, no repository needed
 *   --compare [Caption=]<before path>,<after path>  two files read as a change
 *   --commit  [Caption=]<rev>                       a commit in this folder
 *   --video   [Caption=]<http or https address>     a video somewhere else
 *
 * One caption rule for every flag: the whole value is tried first, and if it
 * is valid as written it is the value and there is no caption. Otherwise the
 * text before the first `=` is the caption, when it has no `=`, `:` or line
 * break and what follows is a valid value. So `--code "ts:const a = 1"` is
 * code, never a caption "ts:const a".
 *
 * Everything made of text or bytes is uploaded (`stageFile`) before the
 * signal is raised, and nothing is uploaded unless every item passes its
 * check: main sees references, a commit id and an address only. A path never
 * crosses the socket. The checks here only fail fast; main is the authority.
 */

/** Where a text comes from: typed inline, a file, or stdin. */
export type AttachText =
  | { readonly from: "inline"; readonly text: string }
  | { readonly from: "file"; readonly path: string }
  | { readonly from: "stdin" };

export type AttachPlan = { readonly caption?: string } & (
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "code"; readonly language: string; readonly text: AttachText }
  | { readonly kind: "diff"; readonly text: AttachText }
  | { readonly kind: "compare"; readonly before: AttachText; readonly after: AttachText; readonly language?: string }
  | { readonly kind: "commit"; readonly rev: string }
  | { readonly kind: "video"; readonly url: string }
);

export type AttachFlags = {
  readonly attach?: ReadonlyArray<string>;
  readonly code?: ReadonlyArray<string>;
  readonly diff?: ReadonlyArray<string>;
  readonly compare?: ReadonlyArray<string>;
  readonly commit?: ReadonlyArray<string>;
  readonly video?: ReadonlyArray<string>;
};

/** What the checks ask of the machine, so the parsing itself stays pure. */
export type AttachProbe = {
  readonly isFile: (path: string) => boolean;
  /** A rev as a full commit id in the working folder, or undefined. */
  readonly resolveCommit: (rev: string) => string | undefined;
};

const FULL_SHA = /^[a-f0-9]{40}$/iu;

export const liveAttachProbe: AttachProbe = {
  isFile: (path) => {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  },
  resolveCommit: (rev) => {
    if (rev.trim() === "" || /\s/u.test(rev) || rev.startsWith("-")) return undefined;
    const run = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`, "--"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sha = run.status === 0 ? run.stdout.trim().toLowerCase() : "";
    if (FULL_SHA.test(sha)) return sha;
    // Outside a git folder only a full id is taken as written.
    return FULL_SHA.test(rev) ? rev.toLowerCase() : undefined;
  },
};

const FLAG_HELP = {
  attach: { looks: "a path to a file that exists", example: '--attach "Before=/abs/before.png"' },
  code: {
    looks: "<language>:<text>, where the text may be @file (a file that exists) or - for stdin",
    example: '--code "The guard=ts:if (!user) return;"',
  },
  diff: {
    looks: "unified diff text (it starts with diff, ---, Index: or @@), @file (a file that exists), or - for stdin",
    example: 'git diff | junto feedback "..." --diff "What changed=-"',
  },
  compare: { looks: "<before path>,<after path>, two files that exist", example: '--compare "The limit=old.ts,new.ts"' },
  commit: { looks: "a commit in this folder: HEAD, a branch, or an id", example: '--commit "The fix=HEAD"' },
  video: { looks: "an address that starts with http:// or https://", example: '--video "The run=https://host/run.mp4"' },
} as const;

type FlagName = keyof typeof FLAG_HELP;

/** A value as an error repeats it: whole when it is one line, else its first line. */
const shown = (value: string): string => {
  const line = value.split("\n")[0] ?? "";
  return line.length < value.length || line.length > 400 ? `${line.slice(0, 400)}…` : line;
};

const flagError = (flag: FlagName, value: string, why?: string) =>
  new InputError({
    message: `--${flag}: ${why ?? `"${shown(value)}" is not ${FLAG_HELP[flag].looks}`}`,
    path: `--${flag}`,
    hint: `a valid value is ${FLAG_HELP[flag].looks}, for example ${FLAG_HELP[flag].example}`,
  });

/**
 * Pure: split `[Caption=]value` by the one caption rule. Undefined when
 * neither the whole value nor what follows a caption is valid.
 */
export const splitCaption = (
  raw: string,
  isValue: (value: string) => boolean,
): { readonly value: string; readonly caption?: string } | undefined => {
  if (isValue(raw)) return { value: raw };
  const at = raw.indexOf("=");
  if (at <= 0) return undefined;
  const caption = raw.slice(0, at).trim();
  const value = raw.slice(at + 1);
  if (caption === "" || /[:\n\r]/u.test(caption)) return undefined;
  return isValue(value) ? { value, caption } : isValue(value.trim()) ? { value: value.trim(), caption } : undefined;
};

/** `@path` names a file only when that file exists: code may well start with `@` (a decorator, a CSS rule). */
const fileNamed = (raw: string, isFile: AttachProbe["isFile"]): string | undefined => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("@") || trimmed.length < 2 || trimmed.includes("\n")) return undefined;
  const path = trimmed.slice(1);
  return isFile(path) ? path : undefined;
};

const textOf = (raw: string, isFile: AttachProbe["isFile"]): AttachText => {
  const trimmed = raw.trim();
  if (trimmed === "-" || trimmed === "@-") return { from: "stdin" };
  const path = fileNamed(raw, isFile);
  return path === undefined ? { from: "inline", text: raw } : { from: "file", path };
};

const CODE_VALUE = /^([A-Za-z0-9.+#_-]{1,32}):([\s\S]+)$/u;
const DIFF_START = /^(?:diff |--- |Index: |@@)/u;
const isDiffValue = (value: string, isFile: AttachProbe["isFile"]): boolean => {
  const trimmed = value.trim();
  return trimmed === "-" || trimmed === "@-" || fileNamed(value, isFile) !== undefined || DIFF_START.test(value.trimStart());
};

/** The one comma at which both sides are files; undefined when none or several. */
const comparePair = (value: string, isFile: AttachProbe["isFile"]): readonly [string, string] | undefined => {
  const pairs: Array<readonly [string, string]> = [];
  for (let at = value.indexOf(","); at >= 0; at = value.indexOf(",", at + 1)) {
    const before = value.slice(0, at).trim();
    const after = value.slice(at + 1).trim();
    if (before && after && isFile(before) && isFile(after)) pairs.push([before, after]);
  }
  return pairs.length === 1 ? pairs[0] : undefined;
};

const withCaption = <T extends object>(plan: T, caption: string | undefined): T & { readonly caption?: string } =>
  caption === undefined ? plan : { ...plan, caption };

/**
 * Pure (given the probe): every flag value as a plan, or the first one that
 * is not valid. The order on the card is fixed: attach, code, diff, compare,
 * commit, video, each in the order given.
 */
export const planAttachFlags = (
  flags: AttachFlags,
  probe: AttachProbe,
): { readonly ok: true; readonly plans: ReadonlyArray<AttachPlan> } | { readonly ok: false; readonly error: InputError } => {
  const plans: AttachPlan[] = [];
  const fail = (flag: FlagName, value: string, why?: string) => ({ ok: false as const, error: flagError(flag, value, why) });
  for (const raw of flags.attach ?? []) {
    const split = splitCaption(raw, probe.isFile);
    if (!split) return fail("attach", raw);
    plans.push(withCaption({ kind: "file" as const, path: split.value }, split.caption));
  }
  for (const raw of flags.code ?? []) {
    const split = splitCaption(raw, (value) => CODE_VALUE.test(value));
    const match = split ? CODE_VALUE.exec(split.value) : null;
    if (!split || !match) return fail("code", raw);
    plans.push(withCaption({ kind: "code" as const, language: match[1]!, text: textOf(match[2]!, probe.isFile) }, split.caption));
  }
  for (const raw of flags.diff ?? []) {
    const split = splitCaption(raw, (value) => isDiffValue(value, probe.isFile));
    if (!split) return fail("diff", raw);
    plans.push(withCaption({ kind: "diff" as const, text: textOf(split.value, probe.isFile) }, split.caption));
  }
  for (const raw of flags.compare ?? []) {
    const split = splitCaption(raw, (value) => comparePair(value, probe.isFile) !== undefined);
    const pair = split ? comparePair(split.value, probe.isFile) : undefined;
    if (!split || !pair) {
      return fail("compare", raw, raw.includes(",")
        ? undefined
        : "two files are needed, split by a comma; for two texts typed inline use the JSON form: {\"before\": \"...\", \"after\": \"...\", \"language\": \"ts\"}");
    }
    plans.push(
      withCaption(
        { kind: "compare" as const, before: { from: "file" as const, path: pair[0] }, after: { from: "file" as const, path: pair[1] } },
        split.caption,
      ),
    );
  }
  for (const raw of flags.commit ?? []) {
    const split = splitCaption(raw, (value) => probe.resolveCommit(value.trim()) !== undefined);
    if (!split) return fail("commit", raw);
    plans.push(withCaption({ kind: "commit" as const, rev: split.value.trim() }, split.caption));
  }
  for (const raw of flags.video ?? []) {
    const split = splitCaption(raw, (value) => /^https?:\/\//iu.test(value.trim()));
    if (!split) return fail("video", raw);
    plans.push(withCaption({ kind: "video" as const, url: split.value.trim() }, split.caption));
  }
  return { ok: true, plans };
};

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const captionField = { caption: Schema.optionalKey(Schema.String) };
const TextOrPath = Schema.Union([Schema.String, Schema.Struct({ path: Schema.String }).annotate(strict)]);

/**
 * One item of the JSON input's `attach` list: exactly one of these shapes.
 * A string is literal text (no `@file`, no `-`); a file is named with `path`.
 */
export const SignalAttachCliItem = Schema.Union([
  Schema.Struct({ path: Schema.String, ...captionField }).annotate(strict),
  Schema.Struct({ code: Schema.String, language: Schema.String, ...captionField }).annotate(strict),
  Schema.Struct({ diff: Schema.String, ...captionField }).annotate(strict),
  Schema.Struct({
    before: TextOrPath,
    after: TextOrPath,
    language: Schema.optionalKey(Schema.String),
    ...captionField,
  }).annotate(strict),
  Schema.Struct({ commit: Schema.String, ...captionField }).annotate(strict),
  Schema.Struct({ url: Schema.String, ...captionField }).annotate(strict),
]);
export type SignalAttachCliItem = typeof SignalAttachCliItem.Type;

const side = (value: string | { readonly path: string }): AttachText =>
  typeof value === "string" ? { from: "inline", text: value } : { from: "file", path: value.path };

/** Pure: the JSON list as plans, in list order. */
export const planAttachItems = (items: ReadonlyArray<SignalAttachCliItem>): ReadonlyArray<AttachPlan> =>
  items.map((item): AttachPlan => {
    const caption = item.caption?.trim() || undefined;
    if ("path" in item) return withCaption({ kind: "file" as const, path: item.path }, caption);
    if ("code" in item) {
      return withCaption({ kind: "code" as const, language: item.language, text: { from: "inline" as const, text: item.code } }, caption);
    }
    if ("diff" in item) return withCaption({ kind: "diff" as const, text: { from: "inline" as const, text: item.diff } }, caption);
    if ("commit" in item) return withCaption({ kind: "commit" as const, rev: item.commit.trim() }, caption);
    if ("url" in item) return withCaption({ kind: "video" as const, url: item.url.trim() }, caption);
    return withCaption(
      {
        kind: "compare" as const,
        before: side(item.before),
        after: side(item.after),
        ...(item.language?.trim() ? { language: item.language.trim() } : {}),
      },
      caption,
    );
  });

/** How many of the plans read stdin. */
export const stdinUses = (plans: ReadonlyArray<AttachPlan>): number =>
  plans.reduce((count, plan) => {
    const texts = plan.kind === "code" || plan.kind === "diff" ? [plan.text] : plan.kind === "compare" ? [plan.before, plan.after] : [];
    return count + texts.filter((text) => text.from === "stdin").length;
  }, 0);

/** A language as a file name: `ts` is `snippet.ts`, a name with a dot is itself. */
export const languageFileName = (language: string, stem = "snippet"): string => {
  const clean = attachmentName(language.trim());
  return clean.includes(".") ? clean : `${stem}.${clean || "txt"}`;
};

const kindError = (plan: AttachPlan, message: string) =>
  new InputError({
    message: `${plan.kind === "file" ? "attach" : plan.kind}: ${message}`,
    path: "attach",
    hint: `for example ${FLAG_HELP[plan.kind === "file" ? "attach" : plan.kind].example}`,
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

/** What is ready to go up: a file on disk, or text held here. */
type Upload = { readonly name: string; readonly mediaType: string } & (
  | { readonly path: string }
  | { readonly text: string }
);

type Checked =
  | { readonly kind: "file"; readonly upload: Upload; readonly caption?: string }
  | { readonly kind: "compare"; readonly before: Upload; readonly after: Upload; readonly name: string; readonly caption?: string }
  | { readonly kind: "commit"; readonly sha: string; readonly caption?: string }
  | { readonly kind: "link"; readonly url: string; readonly caption?: string };

/**
 * Check every plan, then upload what is made of bytes, in order. Nothing is
 * uploaded unless all of them pass. `stdin` is the piped text, read once by
 * the caller, for the one item that asked for it.
 */
export const stageAttachPlans = (
  plans: ReadonlyArray<AttachPlan>,
  options: { readonly stdin?: string; readonly timeoutMs?: number; readonly probe?: AttachProbe } = {},
) =>
  Effect.gen(function* () {
    const probe = options.probe ?? liveAttachProbe;
    const fileUpload = (plan: AttachPlan, path: string) =>
      Effect.tryPromise({
        try: async (): Promise<Upload> => {
          // stat follows a link: what matters is that a regular file is read.
          const info = await stat(path);
          if (!info.isFile()) throw new Error("not a regular file");
          const name = attachmentName(path) || "file";
          const head = await readHead(path, Math.min(info.size, ATTACHMENT_HEAD_BYTES));
          return { name, mediaType: attachmentMediaType(name, head), path };
        },
        catch: (cause) => kindError(plan, `${path}: ${cause instanceof Error ? cause.message : "read failed"}`),
      });
    const textUpload = (plan: AttachPlan, source: AttachText, name: string) =>
      Effect.gen(function* () {
        if (source.from === "file") {
          const upload = yield* fileUpload(plan, source.path);
          const head = yield* Effect.promise(() => readHead(source.path, ATTACHMENT_HEAD_BYTES).catch(() => Buffer.alloc(0)));
          if (!isTextHead(head)) return yield* Effect.fail(kindError(plan, `${source.path}: not a text file`));
          return upload;
        }
        const text = source.from === "stdin" ? options.stdin ?? "" : source.text;
        if (text.trim() === "") {
          return yield* Effect.fail(
            kindError(plan, source.from === "stdin" ? "nothing came in on stdin" : "the text is empty"),
          );
        }
        return { name, mediaType: attachmentMediaType(name, Buffer.from(text.slice(0, ATTACHMENT_HEAD_BYTES))), text } satisfies Upload;
      });

    const checked = yield* Effect.forEach(plans, (plan) =>
      Effect.gen(function* () {
        const caption = plan.caption === undefined ? {} : { caption: plan.caption };
        if (plan.kind === "file") return { kind: "file", upload: yield* fileUpload(plan, plan.path), ...caption } as Checked;
        if (plan.kind === "code") {
          return { kind: "file", upload: yield* textUpload(plan, plan.text, languageFileName(plan.language)), ...caption } as Checked;
        }
        if (plan.kind === "diff") return { kind: "file", upload: yield* textUpload(plan, plan.text, "changes.diff"), ...caption } as Checked;
        if (plan.kind === "compare") {
          const language = plan.language;
          const before: Upload = yield* textUpload(plan, plan.before, languageFileName(language ?? "txt", "before"));
          const after: Upload = yield* textUpload(plan, plan.after, languageFileName(language ?? "txt", "after"));
          // The language, when given; else the after file's own name.
          const name = language ? languageFileName(language) : after.name;
          return { kind: "compare", before, after, name, ...caption } as Checked;
        }
        if (plan.kind === "commit") {
          const sha = probe.resolveCommit(plan.rev);
          if (sha === undefined) {
            return yield* Effect.fail(kindError(plan, `"${plan.rev}" is not a commit in this folder`));
          }
          return { kind: "commit", sha, ...caption } as Checked;
        }
        const link = admitLinkUrl(plan.url);
        if (!link.ok) return yield* Effect.fail(kindError(plan, `${plan.url}: ${link.reason}`));
        return { kind: "link", url: link.url, ...caption } as Checked;
      }),
    );

    const upload = (item: Upload) =>
      Effect.gen(function* () {
        const input = {
          mediaType: item.mediaType,
          displayName: item.name,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        };
        if ("path" in item) {
          const ref = yield* stageFile(item.path, input);
          return { sha256: ref.sha256, byteLength: ref.byteLength };
        }
        // Text typed inline goes up the same way a file does, from a private file of the CLI's own.
        return yield* Effect.acquireUseRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "junto-attach-"))),
          (dir) =>
            Effect.gen(function* () {
              const path = join(dir, "text");
              yield* Effect.promise(() => writeFile(path, item.text, { mode: 0o600 }));
              const ref = yield* stageFile(path, input);
              return { sha256: ref.sha256, byteLength: ref.byteLength };
            }),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
        );
      });

    const out: AgentSignalAttachmentInput[] = [];
    for (const item of checked) {
      const caption = item.caption === undefined ? {} : { caption: item.caption };
      if (item.kind === "file") out.push({ ref: yield* upload(item.upload), ...caption } as AgentSignalAttachmentInput);
      else if (item.kind === "compare") {
        out.push({
          kind: "compare",
          before: yield* upload(item.before),
          after: yield* upload(item.after),
          name: item.name,
          ...caption,
        } as AgentSignalAttachmentInput);
      } else if (item.kind === "commit") out.push({ kind: "commit", sha: item.sha, ...caption });
      else out.push({ kind: "link", url: item.url, ...caption });
    }
    return out;
  });

/** Read one text source of the CLI's own (used for a file named by `@`). */
export const readAttachFile = (path: string): Promise<string> => readFile(path, "utf8");
