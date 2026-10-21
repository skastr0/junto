import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import { ARTIFACT_TYPES } from "../../shared/artifact";
import {
  ARTIFACT_ARGS,
  ARTIFACT_HISTORY_LIMIT_MAX,
  ARTIFACT_LIST_LIMIT_MAX,
  type ArtifactControlOp,
  isArtifactWriteOp,
} from "../../shared/artifact-control";
import { mintItemId } from "../../shared/resource-command";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { InputError } from "../core/errors";
import { opIdFlag, opIdOf } from "../core/op-id";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

/**
 * `junto artifact` (plan 05): list, show, history, create, edit, comment,
 * archive and restore the artifacts on the Artifacts nodes in this seat's
 * reach. Reach admits, not edges. Every write mints its opId here, or takes
 * --op-id to retry one, and create mints the artifact's id. An edit names the
 * version it was written against with --base; a stale one is refused with
 * the head.
 */

const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const artifactArg = Argument.string("artifact").pipe(Argument.withDescription("The artifact's id, as list printed it"));

const call = (op: ArtifactControlOp, args: unknown, timeout: Option.Option<number>) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, Option.getOrUndefined(timeout));
  });

/** One verb's call: the args it names, with an opId when it writes. */
const run = (
  op: ArtifactControlOp,
  args: Effect.Effect<Record<string, unknown>, InputError>,
  opId: Option.Option<string>,
  timeout: Option.Option<number>,
) =>
  executeJsonCommand(
    op.replace(".", " "),
    Effect.gen(function* () {
      const named = yield* args;
      const written = isArtifactWriteOp(op) ? { opId: yield* opIdOf(opId), ...named } : named;
      return yield* call(op, written, timeout);
    }),
  );

/** Flags left out stay out of the args, so main's schema sees only what was named. */
const present = (fields: Record<string, Option.Option<unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => (Option.isSome(value) ? [[key, value.value]] : [])));

/** A flag's JSON, or the input error that names the flag. */
const json = (flag: string, text: string): Effect.Effect<unknown, InputError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new InputError({ message: `--${flag} must be JSON`, path: `--${flag}`, received: text }),
  });

const bodyFlags = {
  markdown: Flag.string("markdown").pipe(Flag.optional, Flag.withDescription("A document's markdown")),
  url: Flag.string("url").pipe(Flag.optional, Flag.withDescription("A link's address")),
  body: Flag.string("body").pipe(Flag.optional, Flag.withDescription("Any type's body as JSON; its type may be left out")),
};

/** At most one of --markdown, --url and --body, as main's BodyInput. */
const bodyOf = (given: {
  readonly markdown: Option.Option<string>;
  readonly url: Option.Option<string>;
  readonly body: Option.Option<string>;
}): Effect.Effect<Record<string, unknown> | undefined, InputError> =>
  Effect.gen(function* () {
    const named = [given.markdown, given.url, given.body].filter(Option.isSome).length;
    if (named > 1) {
      return yield* Effect.fail(new InputError({ message: "name one of --markdown, --url and --body", path: "--body" }));
    }
    if (Option.isSome(given.markdown)) return { markdown: given.markdown.value };
    if (Option.isSome(given.url)) return { url: given.url.value };
    if (Option.isSome(given.body)) return { body: yield* json("body", given.body.value) };
    return undefined;
  });

const DESCRIPTIONS = {
  list: "Artifacts on every Artifacts node in this seat's reach, or on the one --node names, newest change first. Archived ones only with --archived.",
  show: "One artifact as text (a document's markdown, a pad's digest, a sheet as a table) and its body, at the head or at --version.",
  history: "An artifact's versions, newest first: who made each and whether it replaced or patched the body.",
  create: "Create an artifact on the Artifacts node in reach, or the one --node names. Documents, pads and sheets start empty; a link needs --url.",
  edit: "Edit an artifact written against --base: replace its body (--markdown, --url or --body), or patch a pad, sheet or document (--patch).",
  comment: "Post in the artifact's thread, on the whole artifact or at --anchor: box for a pad, cells for a sheet, text for a document.",
  archive: "Archive an artifact. It takes no edits until restored.",
  restore: "Restore an archived artifact.",
} as const satisfies { readonly [Op in ArtifactControlOp as Op extends `artifact.${infer V}` ? V : never]: string };

type Verb = keyof typeof DESCRIPTIONS;
const opOf = (verb: Verb): ArtifactControlOp => `artifact.${verb}`;

const listCommand = Command.make(
  "list",
  {
    node: Flag.string("node").pipe(Flag.optional, Flag.withDescription("An Artifacts node: its id, its name or a junto:// ref")),
    type: Flag.choice("type", ARTIFACT_TYPES).pipe(Flag.optional, Flag.withDescription("Only artifacts of this type")),
    archived: Flag.boolean("archived").pipe(Flag.withDefault(false), Flag.withDescription("List the archived artifacts instead")),
    limit: Flag.integer("limit").pipe(Flag.optional, Flag.withDescription(`At most this many (1 to ${ARTIFACT_LIST_LIMIT_MAX}, default 50)`)),
    timeout: timeoutFlag,
  },
  ({ node, type, archived, limit, timeout }) =>
    run("artifact.list", Effect.succeed({ ...present({ node, type, limit }), ...(archived ? { archived } : {}) }), Option.none(), timeout),
).pipe(Command.withDescription(DESCRIPTIONS.list));

const showCommand = Command.make(
  "show",
  {
    artifact: artifactArg,
    version: Flag.integer("version").pipe(Flag.optional, Flag.withDescription("A past version; the head when left out")),
    timeout: timeoutFlag,
  },
  ({ artifact, version, timeout }) => run("artifact.show", Effect.succeed({ artifact, ...present({ version }) }), Option.none(), timeout),
).pipe(Command.withDescription(DESCRIPTIONS.show));

const historyCommand = Command.make(
  "history",
  {
    artifact: artifactArg,
    limit: Flag.integer("limit").pipe(Flag.optional, Flag.withDescription(`At most this many (1 to ${ARTIFACT_HISTORY_LIMIT_MAX}, default 20)`)),
    before: Flag.integer("before").pipe(Flag.optional, Flag.withDescription("Versions older than this one, for the next page")),
    timeout: timeoutFlag,
  },
  ({ artifact, limit, before, timeout }) =>
    run("artifact.history", Effect.succeed({ artifact, ...present({ limit, before }) }), Option.none(), timeout),
).pipe(Command.withDescription(DESCRIPTIONS.history));

const createCommand = Command.make(
  "create",
  {
    title: Argument.string("title").pipe(Argument.withDescription("The artifact's title")),
    type: Flag.choice("type", ARTIFACT_TYPES).pipe(Flag.withDescription("link, document, pad, sheet or file")),
    node: Flag.string("node").pipe(Flag.optional, Flag.withDescription("The Artifacts node, when more than one is in reach")),
    task: Flag.string("task").pipe(Flag.atLeast(0), Flag.withDescription("A task id this artifact belongs to; repeat for several")),
    ...bodyFlags,
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ title, type, node, task, markdown, url, body, opId, timeout }) =>
    run(
      "artifact.create",
      Effect.map(bodyOf({ markdown, url, body }), (given) => ({
        artifactId: mintItemId(),
        type,
        title,
        ...present({ node }),
        ...(given === undefined ? {} : { body: given }),
        ...(task.length === 0 ? {} : { taskIds: task }),
      })),
      opId,
      timeout,
    ),
).pipe(Command.withDescription(DESCRIPTIONS.create));

const editCommand = Command.make(
  "edit",
  {
    artifact: artifactArg,
    base: Flag.integer("base").pipe(Flag.withDescription("The version this edit was written against, from show")),
    ...bodyFlags,
    patch: Flag.string("patch").pipe(Flag.optional, Flag.withDescription("Patches as a JSON array, for a pad, sheet or document")),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ artifact, base, markdown, url, body, patch, opId, timeout }) =>
    run(
      "artifact.edit",
      Effect.gen(function* () {
        const given = yield* bodyOf({ markdown, url, body });
        const patches = Option.isSome(patch) ? yield* json("patch", patch.value) : undefined;
        return {
          artifact,
          baseVersion: base,
          ...(given === undefined ? {} : { body: given }),
          ...(patches === undefined ? {} : { patches }),
        };
      }),
      opId,
      timeout,
    ),
).pipe(Command.withDescription(DESCRIPTIONS.edit));

const commentCommand = Command.make(
  "comment",
  {
    artifact: artifactArg,
    text: Argument.string("text").pipe(Argument.withDescription("The comment; @name mentions a seat")),
    anchor: Flag.string("anchor").pipe(
      Flag.optional,
      Flag.withDescription('Where it hangs, as JSON: {"kind":"cells","range":"B2"}, {"kind":"text","quote":"..."} or {"kind":"box",...}'),
    ),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ artifact, text, anchor, opId, timeout }) =>
    run(
      "artifact.comment",
      Effect.gen(function* () {
        const at = Option.isSome(anchor) ? yield* json("anchor", anchor.value) : undefined;
        return { artifact, text, ...(at === undefined ? {} : { anchor: at }) };
      }),
      opId,
      timeout,
    ),
).pipe(Command.withDescription(DESCRIPTIONS.comment));

const oneCommand = (verb: "archive" | "restore") =>
  Command.make(verb, { artifact: artifactArg, opId: opIdFlag, timeout: timeoutFlag }, ({ artifact, opId, timeout }) =>
    run(opOf(verb), Effect.succeed({ artifact }), opId, timeout)).pipe(Command.withDescription(DESCRIPTIONS[verb]));

export const artifactCommand = Command.make("artifact").pipe(
  Command.withDescription("Artifacts in this seat's reach: links, documents, pads, sheets and files, versioned"),
  Command.withSubcommands([
    listCommand,
    showCommand,
    historyCommand,
    createCommand,
    editCommand,
    commentCommand,
    oneCommand("archive"),
    oneCommand("restore"),
  ]),
);

// --- discovery ---------------------------------------------------------------

const VERBS = Object.keys(DESCRIPTIONS) as ReadonlyArray<Verb>;

export const artifactSchemas: ReadonlyArray<CommandSchemaContract> = VERBS.map((verb) => ({
  command_id: opOf(verb),
  command: `artifact ${verb}`,
  schema_id: `${opOf(verb)}.input/v1`,
  // A comment is a thread row, no artifact version: its receipt names the row.
  description: verb === "comment"
    ? `${DESCRIPTIONS[verb]} The CLI mints the opId (--op-id retries one). Returns applied with the threadId, the messageId and the seats notified.`
    : isArtifactWriteOp(opOf(verb))
      ? `${DESCRIPTIONS[verb]} The CLI mints the opId (--op-id retries one). Returns applied with the new version, or queued with the opId while the editing machine is away.`
      : DESCRIPTIONS[verb],
  schema: ARTIFACT_ARGS[opOf(verb)] as Schema.Top,
  input_modes: ["argv"],
}));

/** The args as sent: a write carries the opId the CLI minted, and create the artifact's id too. */
const example = (verb: Verb, name: string, description: string, args: ReadonlyArray<string>, input: object): CommandExample => ({
  command_id: opOf(verb),
  command: `artifact ${verb}`,
  name,
  description,
  input: isArtifactWriteOp(opOf(verb)) ? { opId: OP, ...(verb === "create" ? { artifactId: ID } : {}), ...input } : input,
  args: ["artifact", verb, ...args],
});

const ID = "01M5ESMQ2ZT55QZ073EWPH10SG";
const OP = "01M5ESM1XHCJ7JYJDBC37MREBZ";

export const artifactExamples: ReadonlyArray<CommandExample> = [
  example("list", "the sheets in reach", "Every Artifacts node in reach.", ["--type", "sheet"], { type: "sheet" }),
  example("create", "start a document", "It starts at version 1.", ["Release notes", "--type", "document", "--markdown", "# 0.10"], {
    type: "document",
    title: "Release notes",
    body: { markdown: "# 0.10" },
  }),
  example("show", "read an artifact", "A sheet reads as a table with A1 labels.", [ID], { artifact: ID }),
  example("edit", "replace a document", "--base is the version show printed.", [ID, "--base", "3", "--markdown", "# 0.10, final"], {
    artifact: ID,
    baseVersion: 3,
    body: { markdown: "# 0.10, final" },
  }),
  example(
    "edit",
    "set a sheet cell",
    "Patches to different cells both apply when the editing machine rebases them.",
    [ID, "--base", "3", "--patch", '[{"op":"cell","rowId":"r1","columnId":"c2","value":"42"}]'],
    { artifact: ID, baseVersion: 3, patches: [{ op: "cell", rowId: "r1", columnId: "c2", value: "42" }] },
  ),
  example("comment", "comment on a cell range", "The thread hangs on B2:C4.", [ID, "these totals look off", "--anchor", '{"kind":"cells","range":"B2:C4"}'], {
    artifact: ID,
    text: "these totals look off",
    anchor: { kind: "cells", range: "B2:C4" },
  }),
  example("history", "who changed it", "Newest first; --before pages back.", [ID, "--limit", "10"], { artifact: ID, limit: 10 }),
];

export const artifactCapabilities: ReadonlyArray<CommandCapability> = VERBS.map((verb) => ({
  command_id: opOf(verb),
  command: `artifact ${verb}`,
  category: isArtifactWriteOp(opOf(verb)) ? "workflow" : "discovery",
  description: DESCRIPTIONS[verb],
  schemas: artifactSchemas.filter((schema) => schema.command_id === opOf(verb)),
  examples: artifactExamples.filter((entry) => entry.command_id === opOf(verb)),
}));
